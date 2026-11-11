"""Flight-recorder trace store.

Every turn writes a structured record of what happened: the ambient context
that was picked up, the DAG that was planned, each branch's latency, the
evidence that survived the sieve and the millisecond budget for each stage.

The recorder is an in-process ring buffer. It exists so a reviewer can export
one JSON file and replay exactly what the engine did, without attaching a
profiler or a database.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any

from schemas import StageTimings

MAX_TRACES = 25


class TraceRecorder:
    """Keeps the most recent turns and hands them back as JSON."""

    def __init__(self, capacity: int = MAX_TRACES) -> None:
        self._traces: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._current: dict[str, Any] | None = None

    def begin(
        self,
        *,
        message: str,
        focus_level: int,
        ambient: dict[str, Any] | None = None,
        active_app: str = "",
    ) -> dict[str, Any]:
        """Open a new trace record and make it the current one."""
        record: dict[str, Any] = {
            "started_at": int(time.time()),
            "message": message[:2000],
            "focus_level": focus_level,
            "active_app": active_app,
            "ambient": ambient or {},
            "planner": "deterministic",
            "planning_ms": 0,
            "nodes": [],
            "events": [],
            "stages": StageTimings().model_dump(),
            "sources": [],
            "contradictions": [],
            "promise": None,
            "errors": [],
            "total_ms": 0,
        }
        self._current = record
        self._traces.append(record)
        return record

    @property
    def current(self) -> dict[str, Any] | None:
        return self._current

    def note(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        """Append an ordered event to the current trace."""
        if self._current is None:
            return
        self._current["events"].append(
            {"type": event_type, "at_ms": self._elapsed_ms(), **(payload or {})}
        )

    def update_node(self, node: dict[str, Any]) -> None:
        if self._current is None:
            return
        nodes = self._current["nodes"]
        for index, existing in enumerate(nodes):
            if existing.get("id") == node.get("id"):
                nodes[index] = {**existing, **node}
                return
        nodes.append(node)

    def set_stage(self, stage: str, milliseconds: int) -> None:
        if self._current is None:
            return
        self._current["stages"][stage] = int(milliseconds)

    def _elapsed_ms(self) -> int:
        if self._current is None:
            return 0
        return int((time.time() - self._current["started_at"]) * 1000)

    def finish(self, total_ms: int) -> None:
        if self._current is None:
            return
        self._current["total_ms"] = int(total_ms)
        self._current["finished_at"] = int(time.time())
        self._current = None

    def export(self) -> dict[str, Any]:
        """A complete flight-recorder payload, newest trace last."""
        return {
            "tool": "chronos",
            "version": "1.0.0",
            "exported_at": int(time.time()),
            "trace_count": len(self._traces),
            "traces": list(self._traces),
        }

    def recent(self, limit: int = 10) -> list[dict[str, Any]]:
        return list(self._traces)[-limit:]


recorder = TraceRecorder()
