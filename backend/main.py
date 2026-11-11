"""Chronos FastAPI application: HTTP surface and the streaming search orchestrator."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ValidationError

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

import db  # noqa: E402
from engine.context_sieve import ContextSieve, NodeSieveResult  # noqa: E402
from engine.dag_planner import DAGPlanner, clean_for_search  # noqa: E402
from engine.hydrator import Hydrator  # noqa: E402
from engine.promise_daemon import PromiseDaemon  # noqa: E402
from engine.scraper_pool import ScraperPool  # noqa: E402
from engine.synthesizer import Synthesizer  # noqa: E402
from events import broker, runtime  # noqa: E402
from llm_client import LLMClient  # noqa: E402
from schemas import (  # noqa: E402
    ChatRequest,
    CaughtPromise,
    ContradictionsEvent,
    DAGNode,
    DAGPlanEvent,
    DoneEvent,
    ErrorEvent,
    FocusRequest,
    FocusResponse,
    HelloEvent,
    HydrationEvent,
    MemoryEntity,
    NodeAddedEvent,
    NodeStatus,
    NodeUpdateEvent,
    NudgePayload,
    PromiseCaughtEvent,
    ResolveResponse,
    SieveMetricsEvent,
    SimulateMutationRequest,
    SimulateMutationResponse,
    SpeculateRequest,
    SpeculateResponse,
    StateResponse,
    TokenEvent,
    Volatility,
)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
)
logger = logging.getLogger("chronos.api")

llm = LLMClient()
hydrator = Hydrator(llm)
planner = DAGPlanner(llm)
scraper = ScraperPool()
sieve = ContextSieve()
synthesizer = Synthesizer(llm)
promise_daemon = PromiseDaemon(llm)

_background_tasks: set[asyncio.Task[Any]] = set()

# How long the nudge stream waits before emitting an SSE comment to keep
# intermediaries from closing an idle connection.
KEEPALIVE_SECONDS = 15.0


class SpeculationManager:
    """Tracks debounced prefetch work and its observed cache-warming payoff."""

    def __init__(self, pool: ScraperPool) -> None:
        self.pool = pool
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self.warmed_queries: set[str] = set()
        self.saved_ms: dict[str, int] = {}

    async def ensure_started(self, query: str) -> tuple[bool, int]:
        """Warm `query` in the background.

        Returns `(already_warm, saved_ms)`. `saved_ms` is the wall-clock cost
        of the prefetch, which is what the answer would otherwise have paid.
        """
        cached = await db.get_cached_query_any(query)
        if cached is not None and cached.get("fresh"):
            return True, self.saved_ms.get(query, 0)
        existing = self._tasks.get(query)
        if existing is not None and not existing.done():
            return False, 0
        task = asyncio.create_task(self._warm(query), name="chronos-speculation")
        self._tasks[query] = task
        task.add_done_callback(lambda finished, key=query: self._cleanup(key, finished))
        return False, 0

    async def _warm(self, query: str) -> None:
        started = time.perf_counter()
        try:
            await self.pool.warm_dns()
            result = await self.pool.warm_query(query, Volatility.VOLATILE)
            saved = max(1, int((time.perf_counter() - started) * 1000))
            if result.chunks:
                self.warmed_queries.add(query)
                self.saved_ms[query] = max(result.latency_ms, saved)
                logger.info("speculation warmed %r in %dms", query[:70], self.saved_ms[query])
        except Exception as exc:  # noqa: BLE001 - speculation is best-effort
            logger.warning("speculation warm failed for %r: %s", query[:70], str(exc)[:200])

    def _cleanup(self, key: str, task: asyncio.Task[None]) -> None:
        if self._tasks.get(key) is task:
            self._tasks.pop(key, None)
        if not task.cancelled() and task.exception() is not None:
            logger.info("speculative task completed with error: %s", str(task.exception())[:200])


speculation = SpeculationManager(scraper)


def _track_background(task: asyncio.Task[Any]) -> asyncio.Task[Any]:
    _background_tasks.add(task)
    task.add_done_callback(_background_done)
    return task


def _background_done(task: asyncio.Task[Any]) -> None:
    _background_tasks.discard(task)
    if task.cancelled():
        return
    exception = task.exception()
    if exception is not None:
        logger.warning("background task failed: %s", str(exception)[:300])


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await db.init_db()
    runtime.started_at = int(time.time())
    await promise_daemon.start()
    logger.info("Chronos engine online — db=%s focus=%d", db.DB_PATH, runtime.focus_level)
    try:
        yield
    finally:
        await promise_daemon.stop()
        for task in list(_background_tasks):
            task.cancel()
        if _background_tasks:
            await asyncio.gather(*_background_tasks, return_exceptions=True)
        for task in list(speculation._tasks.values()):
            task.cancel()
        await asyncio.gather(*speculation._tasks.values(), return_exceptions=True)
        await llm.close()
        logger.info("Chronos engine offline")


app = FastAPI(
    title="Chronos Engine",
    version="1.0.0",
    description="Ambient, promise-aware web search with a live glass-box telemetry stream.",
    lifespan=lifespan,
)

_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Type"],
)


def _sse(payload: BaseModel | dict[str, Any]) -> str:
    data = payload.model_dump(mode="json") if isinstance(payload, BaseModel) else payload
    return f"data: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


def _sse_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Return JSON instead of a bare 500 HTML page for unexpected failures."""
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": f"{type(exc).__name__}: {str(exc)[:400]}"},
    )


def _focus_label(level: int) -> str:
    return {5: "DEEP_FOCUS", 4: "MEETING", 2: "NORMAL", 1: "IDLE"}.get(level, "NORMAL")


def _wave_groups(nodes: list[DAGNode]) -> list[list[DAGNode]]:
    remaining = {node.id: set(node.depends_on) for node in nodes}
    completed: set[str] = set()
    waves: list[list[DAGNode]] = []
    by_id = {node.id: node for node in nodes}
    while remaining:
        ready = [by_id[node_id] for node_id in remaining if remaining[node_id].issubset(completed)]
        if not ready:
            break
        waves.append(ready)
        for node in ready:
            completed.add(node.id)
            remaining.pop(node.id, None)
    return waves


async def _execute_retrieval(
    node: DAGNode,
    emit: Any,
    *,
    is_retry: bool = False,
) -> list[NodeSieveResult]:
    await emit(
        NodeUpdateEvent(
            node_id=node.id,
            status=NodeStatus.SCRAPING,
            detail="retry branch · broadened query" if is_retry else "hedged fetch across top sources",
        )
    )
    started = time.perf_counter()
    try:
        retrieval = await scraper.search_and_scrape(node.query, node.volatility)
    except Exception as exc:  # noqa: BLE001 - a node must not kill the request
        logger.exception("retrieval crashed for %s", node.id)
        await emit(
            NodeUpdateEvent(
                node_id=node.id,
                status=NodeStatus.FAILED,
                latency_ms=max(1, int((time.perf_counter() - started) * 1000)),
                detail=str(exc)[:240],
            )
        )
        empty = NodeSieveResult(
            node_id=node.id,
            query=node.query,
            needs_healing=True,
            healing_reason=str(exc)[:240],
        )
        return [empty]

    node_result = sieve.sieve_node(node.id, node.query, retrieval.chunks)
    latency = retrieval.latency_ms
    detail_bits: list[str] = []
    if retrieval.cached:
        detail_bits.append(f"epistemic cache · {retrieval.cache_age_seconds}s old")
    if (
        not retrieval.cached
        and retrieval.urls_attempted > 0
        and retrieval.fetched_count == 0
    ):
        node_result.needs_healing = True
        node_result.healing_reason = (
            f"all {retrieval.urls_attempted} target URLs timed out or were blocked"
        )
    if node_result.needs_healing and not is_retry:
        reason = node_result.healing_reason or "weak evidence"
        await emit(
            NodeUpdateEvent(
                node_id=node.id,
                status=NodeStatus.HEALING,
                latency_ms=latency,
                chunks_found=node_result.chunk_count,
                cached=retrieval.cached,
                detail=reason,
            )
        )
        retry_node = await planner.rewrite_node(node, reason)
        await emit(
            NodeAddedEvent(
                node=retry_node,
                reason=f"{reason} — grafting broader branch {retry_node.id}",
            )
        )
        logger.info("self-healing %s via %s", node.id, retry_node.id)
        retry_results = await _execute_retrieval(retry_node, emit, is_retry=True)
        return [node_result, *retry_results]

    if is_retry:
        if not retrieval.chunks:
            status = NodeStatus.FAILED
            detail_bits.append(retrieval.errors[-1] if retrieval.errors else "retry yielded no evidence")
        else:
            status = NodeStatus.CACHED if retrieval.cached else NodeStatus.DONE
            if node_result.needs_healing:
                detail_bits.append(node_result.healing_reason or "retry remains weak")
            else:
                detail_bits.append(f"healed · peak BM25 {node_result.peak_bm25:.2f}")
    else:
        status = NodeStatus.CACHED if retrieval.cached else NodeStatus.DONE
        if retrieval.search_results == 0 and retrieval.errors:
            detail_bits.append(retrieval.errors[-1])
    if retrieval.errors and not detail_bits:
        detail_bits.append(retrieval.errors[-1])
    await emit(
        NodeUpdateEvent(
            node_id=node.id,
            status=status,
            latency_ms=latency,
            chunks_found=node_result.chunk_count,
            cached=retrieval.cached,
            detail=" · ".join(detail_bits)[:300] or None,
        )
    )
    return [node_result]


async def _run_node(
    node: DAGNode, emit: Any
) -> list[NodeSieveResult]:
    return await _execute_retrieval(node, emit)


async def _drain_wave_events(
    tasks: set[asyncio.Task[list[NodeSieveResult]]],
    queue: asyncio.Queue[BaseModel],
) -> AsyncIterator[str]:
    pending = set(tasks)
    try:
        while pending or not queue.empty():
            if queue.empty():
                if not pending:
                    break
                _, pending = await asyncio.wait(
                    pending, timeout=0.1, return_when=asyncio.FIRST_COMPLETED
                )
                continue
            event = queue.get_nowait()
            yield _sse(event)
    finally:
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "name": "Chronos Engine",
        "status": "online",
        "docs": "/docs",
        "focus_level": runtime.focus_level,
        "llm": llm.public_info(),
        "search": scraper.public_info(),
    }


@app.get("/api/health")
async def health() -> dict[str, Any]:
    counts = await db.promise_counts()
    return {
        "status": "ok",
        "db": str(db.DB_PATH),
        "focus_level": runtime.focus_level,
        "llm": llm.public_info(),
        "providers": scraper.public_info(),
        "promises": counts,
        "nudge_subscribers": broker.subscriber_count,
    }


@app.post("/api/speculate", response_model=SpeculateResponse)
async def speculate(payload: SpeculateRequest) -> SpeculateResponse:
    hydration = await hydrator.hydrate_detailed(payload.partial_text)
    predicted = planner.predict_queries(payload.partial_text, hydration.entities)
    entities = [MemoryEntity.model_validate(entity) for entity in hydration.entities]
    if not predicted:
        return SpeculateResponse(
            matched_entities=entities,
            predicted_queries=[],
            warmed=False,
            saved_ms=0,
            status="IDLE",
            speculative_query=None,
        )

    primary = predicted[0]
    warmed, saved_ms = await speculation.ensure_started(primary)
    # Warm the second candidate too; this is deliberately non-blocking. The
    # primary query is what the endpoint reports on, while the secondary warms
    # in the background for a related follow-up branch.
    for secondary in predicted[1:2]:
        if secondary != primary:
            await speculation.ensure_started(secondary)
    return SpeculateResponse(
        matched_entities=entities,
        predicted_queries=predicted,
        warmed=warmed,
        saved_ms=saved_ms,
        status="WARMED" if warmed else "WARMING",
        speculative_query=primary,
    )


@app.post("/api/chat/stream")
async def chat_stream(payload: ChatRequest) -> StreamingResponse:
    async def event_generator() -> AsyncIterator[str]:
        started = time.perf_counter()
        runtime.focus_level = payload.focus_level
        node_tasks: set[asyncio.Task[list[NodeSieveResult]]] = set()
        contradiction_task: asyncio.Task[Any] | None = None
        promise_task: asyncio.Task[Any] | None = None
        try:
            yield ": chronos stream opened\n\n"
            hydration = await hydrator.hydrate_detailed(payload.message)
            predicted = planner.predict_queries(payload.message, hydration.entities)
            speculative_hit = any(query in speculation.warmed_queries for query in predicted)
            yield _sse(
                HydrationEvent(
                    entities=[MemoryEntity.model_validate(entity) for entity in hydration.entities],
                    context=hydration.context,
                    pronouns_resolved=hydration.pronouns_resolved,
                    speculative_hit=speculative_hit,
                    latency_ms=hydration.latency_ms,
                )
            )

            plan, planner_kind, planning_ms = await planner.plan(
                payload.message, hydration.context, hydration.entities
            )
            yield _sse(
                DAGPlanEvent(
                    nodes=plan.nodes,
                    planning_ms=planning_ms,
                    planner="llm" if planner_kind == "llm" else "deterministic",
                )
            )

            queue: asyncio.Queue[BaseModel] = asyncio.Queue()

            async def emit(event: BaseModel) -> None:
                await queue.put(event)

            all_results: list[NodeSieveResult] = []
            for wave in _wave_groups(plan.nodes):
                wave_tasks = {
                    asyncio.create_task(_run_node(node, emit), name=f"chronos-{node.id}")
                    for node in wave
                }
                node_tasks.update(wave_tasks)
                async for chunk in _drain_wave_events(wave_tasks, queue):
                    yield chunk
                wave_outputs = await asyncio.gather(*wave_tasks, return_exceptions=True)
                for output in wave_outputs:
                    if isinstance(output, BaseException):
                        logger.warning("wave node failed: %s", str(output)[:300])
                        continue
                    all_results.extend(output)
                node_tasks.difference_update(wave_tasks)

            metrics = sieve.assemble(all_results)
            yield _sse(
                SieveMetricsEvent(
                    raw_tokens=metrics.raw_tokens,
                    sieved_tokens=metrics.sieved_tokens,
                    compression_pct=metrics.compression_pct,
                    peak_bm25=metrics.peak_bm25,
                    sources=metrics.sources,
                )
            )

            research_query = clean_for_search(payload.message) or payload.message
            contradiction_task = _track_background(
                asyncio.create_task(
                    synthesizer.detect_contradictions(research_query, metrics.sources),
                    name="chronos-contradictions",
                )
            )

            answer = ""
            async for delta in synthesizer.stream_answer(research_query, metrics.sources):
                answer += delta
                yield _sse(TokenEvent(delta=delta))
            if not answer:
                fallback = (
                    "The synthesis stream returned no content. The retrieved evidence is still "
                    "available in the inspector."
                )
                yield _sse(TokenEvent(delta=fallback))

            # Explicit out-of-band task per the promise daemon contract.
            promise_task = _track_background(
                asyncio.create_task(
                    promise_daemon.extract_promise(payload.message, metrics.sources),
                    name="chronos-promise-extraction",
                )
            )

            contradiction_items = []
            if contradiction_task is not None:
                done, _ = await asyncio.wait({contradiction_task}, timeout=8.0)
                if contradiction_task in done:
                    try:
                        contradiction_items = contradiction_task.result()
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("contradiction task failed: %s", str(exc)[:240])
                else:
                    contradiction_task.cancel()
                    logger.info("contradiction audit timed out; continuing without conflicts")
            yield _sse(ContradictionsEvent(items=contradiction_items))

            if promise_task is not None:
                done, _ = await asyncio.wait({promise_task}, timeout=6.0)
                if promise_task in done:
                    try:
                        caught_promise, is_duplicate = promise_task.result()
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("promise extraction failed: %s", str(exc)[:240])
                        caught_promise, is_duplicate = None, False
                    if caught_promise is not None and not is_duplicate:
                        try:
                            yield _sse(
                                PromiseCaughtEvent(promise=CaughtPromise.model_validate(caught_promise))
                            )
                        except ValidationError as exc:
                            logger.warning("invalid caught promise payload: %s", exc)
                else:
                    logger.info(
                        "promise extraction still running after 6s; it will publish on /api/nudges/stream"
                    )

            _track_background(
                asyncio.create_task(
                    hydrator.extract_and_persist_entities(payload.message),
                    name="chronos-memory-writeback-post",
                )
            )
            yield _sse(DoneEvent(elapsed_ms=max(1, int((time.perf_counter() - started) * 1000))))
        except asyncio.CancelledError:
            logger.info("chat stream disconnected by client")
            raise
        except Exception as exc:  # noqa: BLE001 - always end with SSE error, never dangling HTML
            logger.exception("chat stream failed")
            yield _sse(ErrorEvent(message=f"{type(exc).__name__}: {str(exc)[:400]}"))
        finally:
            for task in list(node_tasks):
                task.cancel()
            if node_tasks:
                await asyncio.gather(*node_tasks, return_exceptions=True)
            # A disconnected browser should not leave the contradiction audit
            # and the promise extraction running in the background.
            for task in (contradiction_task, promise_task):
                if task is not None and not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers=_sse_headers(),
    )


@app.get("/api/nudges/stream")
async def nudge_stream(request: Request) -> StreamingResponse:
    async def event_generator() -> AsyncIterator[str]:
        queue = await broker.subscribe()
        try:
            counts = await db.promise_counts()
            yield _sse(
                HelloEvent(
                    focus_level=runtime.focus_level,
                    active_promises=counts["active"],
                )
            )
            while True:
                # Deliberately no `request.is_disconnected()` here. Starlette
                # already owns the receive channel for a StreamingResponse and
                # cancels the generator when the peer goes away; polling the
                # same channel competes with it for the `http.disconnect`
                # message and can strand this generator (and its broker
                # subscription) forever.
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield _sse(event)
        except asyncio.CancelledError:
            raise
        finally:
            await broker.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers=_sse_headers(),
    )


@app.post("/api/focus", response_model=FocusResponse)
async def set_focus(payload: FocusRequest) -> FocusResponse:
    runtime.focus_level = payload.focus_level
    released, promises = await promise_daemon.release_queued(payload.focus_level)
    return FocusResponse(
        focus_level=payload.focus_level,
        released=released,
        promises=[CaughtPromise.model_validate(promise) for promise in promises],
    )


@app.post("/api/simulate-mutation", response_model=SimulateMutationResponse)
async def simulate_mutation(payload: SimulateMutationRequest) -> SimulateMutationResponse:
    if payload.focus_level is not None:
        runtime.focus_level = payload.focus_level
    try:
        result = await promise_daemon.simulate_webpage_mutation(
            payload.promise_id, runtime.focus_level
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Promise not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return SimulateMutationResponse(
        promise=CaughtPromise.model_validate(result["promise"]),
        urgency=result["urgency"],
        gated=result["gated"],
        focus_level=result["focus_level"],
        nudge=NudgePayload.model_validate(result["nudge"]) if result["nudge"] else None,
        message=result["message"],
    )


@app.post("/api/promises/{promise_id}/resolve", response_model=ResolveResponse)
async def resolve_promise(promise_id: str) -> ResolveResponse:
    promise = await db.get_promise(promise_id)
    if promise is None:
        raise HTTPException(status_code=404, detail="Promise not found")
    updated = await db.update_promise(promise_id, status="RESOLVED")
    if updated is None:
        raise HTTPException(status_code=404, detail="Promise not found")
    validated = CaughtPromise.model_validate(updated)
    await broker.publish(
        {"type": "PROMISE_UPDATED", "promise": validated.model_dump(mode="json")}
    )
    return ResolveResponse(promise=validated, status="RESOLVED")


@app.get("/api/state", response_model=StateResponse)
async def state() -> StateResponse:
    entities = await db.get_entities()
    promises = await db.list_promises(include_resolved=True)
    counts = await db.promise_counts()
    providers = scraper.public_info()
    providers["llm"] = llm.available
    return StateResponse(
        memory_entities=[MemoryEntity.model_validate(entity) for entity in entities],
        caught_promises=[CaughtPromise.model_validate(promise) for promise in promises],
        focus_level=runtime.focus_level,
        focus_label=_focus_label(runtime.focus_level),
        active_promises=counts["active"],
        queued_promises=counts["QUEUED_QUIET"],
        providers=providers,
    )
