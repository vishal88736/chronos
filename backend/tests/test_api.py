"""HTTP-surface checks for the Chronos FastAPI app.

Run with:  backend/.venv/bin/python -m tests.test_api
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

os.environ.setdefault("CHRONOS_DB_PATH", str(Path(tempfile.gettempdir()) / "chronos-api-test.db"))

import httpx  # noqa: E402

import db  # noqa: E402
from events import broker, runtime  # noqa: E402
from main import app  # noqa: E402

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  PASS  {name}")
    else:
        FAILED.append(f"{name}: {detail}")
        print(f"  FAIL  {name} — {detail}")


def parse_events(text: str) -> list[dict]:
    events: list[dict] = []
    for block in text.split("\n\n"):
        for line in block.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
                if not payload or payload.startswith(":"):
                    continue
                try:
                    events.append(json.loads(payload))
                except json.JSONDecodeError:
                    continue
    return events


async def test_health_and_state() -> None:
    print("\n[api] health and state")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        health = await client.get("/api/health")
        check("health returns 200", health.status_code == 200, str(health.status_code))
        payload = health.json()
        check("health reports status ok", payload.get("status") == "ok", str(payload))
        check("health reports providers", "providers" in payload, str(payload))

        state = await client.get("/api/state")
        check("state returns 200", state.status_code == 200, str(state.status_code))
        body = state.json()
        check("state carries memory entities", isinstance(body.get("memory_entities"), list))
        check("state carries a focus label", bool(body.get("focus_label")), str(body.get("focus_label")))
        check("state providers include llm flag", "llm" in body.get("providers", {}), str(body.get("providers")))


async def test_validation() -> None:
    print("\n[api] request validation")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        blank = await client.post("/api/speculate", json={"partial_text": "   "})
        check("blank speculate is rejected", blank.status_code == 422, str(blank.status_code))

        bad_focus = await client.post("/api/focus", json={"focus_level": 3})
        check("invalid focus level is rejected", bad_focus.status_code == 422, str(bad_focus.status_code))

        blank_chat = await client.post("/api/chat/stream", json={"message": "  "})
        check("blank chat message is rejected", blank_chat.status_code == 422, str(blank_chat.status_code))

        unknown = await client.post("/api/focus", json={"focus_level": 2, "extra": 1})
        check("unknown fields are rejected", unknown.status_code == 422, str(unknown.status_code))


async def test_chat_stream_shape() -> None:
    print("\n[api] chat stream emits a well-formed event sequence")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        async with client.stream(
            "POST",
            "/api/chat/stream",
            json={"message": "Screencapturekit memory leak status", "focus_level": 5},
            timeout=120.0,
        ) as response:
            check("chat stream returns 200", response.status_code == 200, str(response.status_code))
            check(
                "chat stream is an event stream",
                response.headers.get("content-type", "").startswith("text/event-stream"),
                response.headers.get("content-type", ""),
            )
            body = ""
            async for chunk in response.aiter_text():
                body += chunk
                if '"type":"DONE"' in body:
                    break

    events = parse_events(body)
    types = [event.get("type") for event in events]
    check("hydration event present", "HYDRATION" in types, str(types))
    check("dag plan event present", "DAG_PLAN" in types, str(types))
    check("node update event present", "NODE_UPDATE" in types, str(types))
    check("sieve metrics event present", "SIEVE_METRICS" in types, str(types))
    check("token events present", "TOKEN" in types, str(types))
    check("done event present", "DONE" in types, str(types))
    check("no error event", "ERROR" not in types, str(types))

    plan = next((e for e in events if e.get("type") == "DAG_PLAN"), None)
    if plan is not None:
        check("plan carries 2+ nodes", len(plan.get("nodes", [])) >= 2, str(plan.get("nodes")))
        check("plan names a planner", plan.get("planner") in {"llm", "deterministic"}, str(plan.get("planner")))

    metrics = next((e for e in events if e.get("type") == "SIEVE_METRICS"), None)
    if metrics is not None:
        urls = [source["url"] for source in metrics.get("sources", [])]
        per_url = {url: urls.count(url) for url in set(urls)}
        check(
            "evidence budget is diverse",
            all(count <= 2 for count in per_url.values()) and len(urls) >= 2,
            str(per_url),
        )


async def test_nudge_stream_subscription_cleanup() -> None:
    print("\n[api] the nudge stream releases its subscription on disconnect")
    before = broker.subscriber_count
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        async with client.stream("GET", "/api/nudges/stream", timeout=30.0) as response:
            check("nudge stream returns 200", response.status_code == 200, str(response.status_code))
            check(
                "nudge stream is an event stream",
                response.headers.get("content-type", "").startswith("text/event-stream"),
                response.headers.get("content-type", ""),
            )
            async for chunk in response.aiter_text():
                if '"type":"HELLO"' in chunk:
                    break
        # Leaving the context manager closes the underlying connection.
    await asyncio.sleep(0.6)
    check(
        "subscriber count returns to its baseline",
        broker.subscriber_count <= before,
        f"before={before} after={broker.subscriber_count}",
    )


async def test_focus_and_simulation() -> None:
    print("\n[api] focus transitions and mutation simulation")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        focus = await client.post("/api/focus", json={"focus_level": 1})
        check("focus switch returns 200", focus.status_code == 200, str(focus.status_code))
        body = focus.json()
        check("focus response echoes the level", body.get("focus_level") == 1, str(body))
        check("focus response lists promises", isinstance(body.get("promises"), list), str(body))

        simulation = await client.post("/api/simulate-mutation", json={"focus_level": 1})
        check("simulation returns 200", simulation.status_code == 200, str(simulation.status_code))
        payload = simulation.json()
        check("simulation returns a promise", bool(payload.get("promise", {}).get("id")), str(payload))
        check("simulation reports urgency", isinstance(payload.get("urgency"), (int, float)), str(payload))

        deep = await client.post("/api/simulate-mutation", json={"focus_level": 5})
        check("simulation at deep focus is gated", deep.json().get("gated") is True, str(deep.json()))

        missing = await client.post("/api/simulate-mutation", json={"promise_id": "pm_nope"})
        check("unknown promise returns 404", missing.status_code == 404, str(missing.status_code))

        resolved = await client.post("/api/promises/pm_nope/resolve")
        check("resolving an unknown promise returns 404", resolved.status_code == 404, str(resolved.status_code))


async def main() -> int:
    await db.init_db()
    await test_health_and_state()
    await test_validation()
    await test_focus_and_simulation()
    await test_chat_stream_shape()
    await test_nudge_stream_subscription_cleanup()

    print(f"\n{'=' * 60}")
    print(f"passed: {len(PASSED)}   failed: {len(FAILED)}")
    for failure in FAILED:
        print(f"  ✗ {failure}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
