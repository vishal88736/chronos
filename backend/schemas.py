"""Strict Pydantic v2 contracts shared by the API, engines and SSE surface."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Volatility(str, Enum):
    STATIC = "STATIC"
    VOLATILE = "VOLATILE"


class NodeStatus(str, Enum):
    PENDING = "PENDING"
    SCRAPING = "SCRAPING"
    CACHED = "CACHED"
    HEALING = "HEALING"
    DONE = "DONE"
    FAILED = "FAILED"


class PromiseStatus(str, Enum):
    WATCHING = "WATCHING"
    QUEUED_QUIET = "QUEUED_QUIET"
    NUDGED = "NUDGED"
    RESOLVED = "RESOLVED"


FOCUS_LEVELS: dict[int, str] = {
    5: "DEEP_FOCUS",
    4: "MEETING",
    2: "NORMAL",
    1: "IDLE",
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Memory / hydration ────────────────────────────────────────────────────────


class MemoryEntity(StrictModel):
    key: str = Field(min_length=1, max_length=160)
    value: str = Field(min_length=1, max_length=2000)
    category: str = Field(min_length=1, max_length=80)
    updated_at: int


class HydrationPayload(StrictModel):
    context: str
    entities: list[MemoryEntity]
    pronouns_resolved: list[str] = Field(default_factory=list)


class EntityExtraction(StrictModel):
    facts: list[dict[str, str]] = Field(default_factory=list)

    @field_validator("facts")
    @classmethod
    def cap_facts(cls, facts: list[dict[str, str]]) -> list[dict[str, str]]:
        return facts[:8]


# ── DAG planning ──────────────────────────────────────────────────────────────


class DAGNode(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_]+$", min_length=1, max_length=48)
    query: str = Field(min_length=3, max_length=600)
    depends_on: list[str] = Field(default_factory=list)
    volatility: Volatility = Volatility.VOLATILE
    retry_of: str | None = None

    @field_validator("depends_on")
    @classmethod
    def unique_dependencies(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        return " ".join(value.split())


class DAGPlan(StrictModel):
    nodes: list[DAGNode] = Field(min_length=2, max_length=4)

    @model_validator(mode="after")
    def validate_dag(self) -> "DAGPlan":
        ids = [node.id for node in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("DAG node ids must be unique")
        known = set(ids)
        for node in self.nodes:
            if node.id in node.depends_on:
                raise ValueError(f"{node.id} cannot depend on itself")
            unknown = set(node.depends_on) - known
            if unknown:
                raise ValueError(f"{node.id} depends on unknown nodes: {sorted(unknown)}")
        # Kahn's algorithm: reject cycles so the executor cannot deadlock.
        indegree = {node.id: len(node.depends_on) for node in self.nodes}
        children: dict[str, list[str]] = {node.id: [] for node in self.nodes}
        for node in self.nodes:
            for parent in node.depends_on:
                children[parent].append(node.id)
        ready = [node_id for node_id, degree in indegree.items() if degree == 0]
        visited = 0
        while ready:
            current = ready.pop()
            visited += 1
            for child in children[current]:
                indegree[child] -= 1
                if indegree[child] == 0:
                    ready.append(child)
        if visited != len(self.nodes):
            raise ValueError("DAG contains a cycle")
        return self


class DAGPlanPayload(StrictModel):
    nodes: list[dict[str, Any]]


class RetryPlan(StrictModel):
    query: str = Field(min_length=3, max_length=600)
    volatility: Volatility = Volatility.VOLATILE


# ── Retrieval / sieve ─────────────────────────────────────────────────────────


class SourceChunk(StrictModel):
    id: str
    node_id: str
    title: str
    url: str
    text: str
    bm25_score: float = 0.0
    token_count: int = 0


class SieveMetrics(StrictModel):
    raw_tokens: int
    sieved_tokens: int
    compression_pct: float
    peak_bm25: float
    raw_chunks: int
    selected_chunks: int
    total_scraped_words: int
    sources: list[SourceChunk]


class NodeExecutionResult(StrictModel):
    node: DAGNode
    status: NodeStatus
    latency_ms: int
    chunks: list[dict[str, Any]]
    chunk_count: int
    cached: bool = False
    error: str | None = None


class Contradiction(StrictModel):
    topic: str
    source_a: str
    source_b: str
    detail: str = ""
    source_a_url: str | None = None
    source_b_url: str | None = None


# ── Promises / cognitive load ─────────────────────────────────────────────────


class CaughtPromise(StrictModel):
    id: str
    actor: str
    recipient: str
    promised_action: str
    trigger_condition: str
    watch_url: str
    last_dom_hash: str
    priority: int = Field(ge=1, le=5)
    time_sensitivity: int = Field(ge=1, le=5)
    status: PromiseStatus
    draft_artifact: str | None = None
    trigger_summary: str | None = None
    created_at: int


class NudgePayload(StrictModel):
    promise_id: str
    urgency: float
    focus_level: int
    trigger_summary: str
    draft_artifact: str | None
    recipient: str
    promised_action: str


class PromiseExtraction(StrictModel):
    actor: str = "You"
    recipient: str
    promised_action: str
    trigger_condition: str
    priority: int = Field(default=2, ge=1, le=5)
    time_sensitivity: int = Field(default=2, ge=1, le=5)
    watch_url: str | None = None


# ── API requests / responses ──────────────────────────────────────────────────


def _validate_focus(value: int) -> int:
    if value not in FOCUS_LEVELS:
        raise ValueError("focus_level must be one of 5 (deep focus), 4 (meeting), 2 (normal) or 1 (idle)")
    return value


class SpeculateRequest(StrictModel):
    partial_text: str = Field(min_length=1, max_length=4000)

    @field_validator("partial_text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("partial_text cannot be blank")
        return value


class SpeculateResponse(StrictModel):
    matched_entities: list[MemoryEntity]
    predicted_queries: list[str]
    warmed: bool
    saved_ms: int
    status: Literal["WARMED", "WARMING", "IDLE"]
    speculative_query: str | None = None


class ChatRequest(StrictModel):
    message: str = Field(min_length=1, max_length=8000)
    focus_level: int = 2

    @field_validator("message")
    @classmethod
    def message_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message cannot be blank")
        return value.strip()

    @field_validator("focus_level")
    @classmethod
    def focus_is_valid(cls, value: int) -> int:
        return _validate_focus(value)


class FocusRequest(StrictModel):
    focus_level: int

    @field_validator("focus_level")
    @classmethod
    def focus_is_valid(cls, value: int) -> int:
        return _validate_focus(value)


class FocusResponse(StrictModel):
    focus_level: int
    released: list[NudgePayload]
    promises: list[CaughtPromise]


class SimulateMutationRequest(StrictModel):
    promise_id: str | None = None
    focus_level: int | None = None

    @field_validator("focus_level")
    @classmethod
    def focus_is_valid(cls, value: int | None) -> int | None:
        if value is None:
            return None
        return _validate_focus(value)


class SimulateMutationResponse(StrictModel):
    promise: CaughtPromise
    urgency: float
    gated: bool
    focus_level: int
    nudge: NudgePayload | None
    message: str


class ResolveResponse(StrictModel):
    promise: CaughtPromise
    status: Literal["RESOLVED"]


class StateResponse(StrictModel):
    memory_entities: list[MemoryEntity]
    caught_promises: list[CaughtPromise]
    focus_level: int
    focus_label: str
    active_promises: int
    queued_promises: int
    providers: dict[str, bool]


# ── SSE event envelopes ───────────────────────────────────────────────────────


class HydrationEvent(StrictModel):
    type: Literal["HYDRATION"] = "HYDRATION"
    entities: list[MemoryEntity]
    context: str
    pronouns_resolved: list[str] = Field(default_factory=list)
    speculative_hit: bool = False
    latency_ms: int = 0


class DAGPlanEvent(StrictModel):
    type: Literal["DAG_PLAN"] = "DAG_PLAN"
    nodes: list[DAGNode]
    planning_ms: int = 0
    planner: Literal["llm", "deterministic"] = "deterministic"


class NodeUpdateEvent(StrictModel):
    type: Literal["NODE_UPDATE"] = "NODE_UPDATE"
    node_id: str
    status: NodeStatus
    latency_ms: int = 0
    chunks_found: int = 0
    cached: bool = False
    detail: str | None = None


class NodeAddedEvent(StrictModel):
    type: Literal["NODE_ADDED"] = "NODE_ADDED"
    node: DAGNode
    reason: str


class SieveMetricsEvent(StrictModel):
    type: Literal["SIEVE_METRICS"] = "SIEVE_METRICS"
    raw_tokens: int
    sieved_tokens: int
    compression_pct: float
    peak_bm25: float
    sources: list[SourceChunk]


class TokenEvent(StrictModel):
    type: Literal["TOKEN"] = "TOKEN"
    delta: str


class ContradictionsEvent(StrictModel):
    type: Literal["CONTRADICTIONS"] = "CONTRADICTIONS"
    items: list[Contradiction]


class PromiseCaughtEvent(StrictModel):
    type: Literal["PROMISE_CAUGHT"] = "PROMISE_CAUGHT"
    promise: CaughtPromise


class NudgeEvent(StrictModel):
    type: Literal["NUDGE"] = "NUDGE"
    nudge: NudgePayload


class PromiseUpdatedEvent(StrictModel):
    type: Literal["PROMISE_UPDATED"] = "PROMISE_UPDATED"
    promise: CaughtPromise


class DoneEvent(StrictModel):
    type: Literal["DONE"] = "DONE"
    elapsed_ms: int


class ErrorEvent(StrictModel):
    type: Literal["ERROR"] = "ERROR"
    message: str


class HelloEvent(StrictModel):
    type: Literal["HELLO"] = "HELLO"
    focus_level: int
    active_promises: int
