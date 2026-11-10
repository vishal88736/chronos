"""Async SQLite persistence for Chronos.

Three tables, created idempotently on startup:
  * memory_entities  — the local personal context graph
  * epistemic_cache  — TTL-scoped, volatility-aware retrieval cache
  * caught_promises  — the out-of-band promise vault

Every connection is short-lived and WAL-enabled, which keeps the background
promise daemon from blocking a streaming chat request.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Iterable

import aiosqlite
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

_raw_db_path = os.getenv("CHRONOS_DB_PATH", "chronos.db").strip() or "chronos.db"
DB_PATH = Path(_raw_db_path).expanduser()
if not DB_PATH.is_absolute():
    DB_PATH = BASE_DIR / DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_entities (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    category TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS epistemic_cache (
    query_hash TEXT PRIMARY KEY,
    query_text TEXT NOT NULL,
    volatility TEXT NOT NULL, -- 'STATIC' or 'VOLATILE'
    chunks_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS caught_promises (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    recipient TEXT NOT NULL,
    promised_action TEXT NOT NULL,
    trigger_condition TEXT NOT NULL,
    watch_url TEXT NOT NULL,
    last_dom_hash TEXT NOT NULL,
    priority INTEGER NOT NULL, -- 1 to 5
    time_sensitivity INTEGER NOT NULL, -- 1 to 5
    status TEXT NOT NULL, -- 'WATCHING', 'QUEUED_QUIET', 'NUDGED', 'RESOLVED'
    draft_artifact TEXT,
    trigger_summary TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promises_status ON caught_promises(status);
CREATE INDEX IF NOT EXISTS idx_cache_created_at ON epistemic_cache(created_at);
"""

SEED_ENTITIES: tuple[tuple[str, str, str], ...] = (
    ("rahul", "Rahul Sharma (Lead Systems Engineer on ScreenKit-Mac repository)", "colleague"),
    ("my stack", "macOS Sequoia 15.4 Beta, Swift 6, Python FastAPI, Next.js", "tech_stack"),
    ("our target latency", "Sub-2000ms p95 end-to-end web search synthesis", "metric"),
)

# Only these columns can ever flow from LLM output or request bodies into SQL.
_PROMISE_UPDATE_COLUMNS = {
    "actor",
    "recipient",
    "promised_action",
    "trigger_condition",
    "watch_url",
    "last_dom_hash",
    "priority",
    "time_sensitivity",
    "status",
    "draft_artifact",
    "trigger_summary",
}


@asynccontextmanager
async def connect() -> AsyncIterator[aiosqlite.Connection]:
    """Open a tuned, short-lived connection with dict-like rows."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA busy_timeout=5000")
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA synchronous=NORMAL")
        yield db


async def init_db() -> None:
    """Create the schema and seed the context graph exactly once."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with connect() as db:
        await db.executescript(SCHEMA)
        count_row = await (await db.execute("SELECT COUNT(*) AS n FROM memory_entities")).fetchone()
        if count_row is not None and int(count_row["n"]) == 0:
            now = int(time.time())
            await db.executemany(
                "INSERT INTO memory_entities (key, value, category, updated_at) VALUES (?, ?, ?, ?)",
                [(key, value, category, now) for key, value, category in SEED_ENTITIES],
            )
        await db.commit()


def normalize_query(query: str) -> str:
    """Normalize for stable semantic-ish cache keys and BM25 queries."""
    lowered = query.lower().strip()
    collapsed = re.sub(r"[^\w]+", " ", lowered, flags=re.UNICODE)
    return " ".join(collapsed.split())


def query_hash(query: str) -> str:
    return hashlib.sha256(normalize_query(query).encode("utf-8")).hexdigest()


# ── Memory entities ───────────────────────────────────────────────────────────


def _entity_row(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "key": str(row["key"]),
        "value": str(row["value"]),
        "category": str(row["category"]),
        "updated_at": int(row["updated_at"]),
    }


async def get_entities() -> list[dict[str, Any]]:
    async with connect() as db:
        cursor = await db.execute(
            "SELECT key, value, category, updated_at FROM memory_entities ORDER BY category, key"
        )
        rows = await cursor.fetchall()
    return [_entity_row(row) for row in rows]


async def upsert_entity(key: str, value: str, category: str) -> dict[str, Any]:
    clean_key = " ".join(key.lower().strip().split())
    clean_value = " ".join(value.strip().split())
    clean_category = " ".join(category.lower().strip().split()) or "fact"
    if not clean_key or not clean_value:
        raise ValueError("entity key and value are required")
    now = int(time.time())
    async with connect() as db:
        await db.execute(
            """
            INSERT INTO memory_entities (key, value, category, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                category = excluded.category,
                updated_at = excluded.updated_at
            """,
            (clean_key, clean_value, clean_category, now),
        )
        await db.commit()
        row = await (await db.execute(
            "SELECT key, value, category, updated_at FROM memory_entities WHERE key = ?",
            (clean_key,),
        )).fetchone()
    if row is None:
        raise RuntimeError("entity upsert succeeded but row could not be read")
    return _entity_row(row)


# ── Epistemic cache ───────────────────────────────────────────────────────────


def _cache_row(row: aiosqlite.Row, now: int) -> dict[str, Any]:
    try:
        chunks = json.loads(row["chunks_json"])
        if not isinstance(chunks, list):
            chunks = []
    except (json.JSONDecodeError, TypeError):
        chunks = []
    created_at = int(row["created_at"])
    ttl = int(row["ttl_seconds"])
    return {
        "query_hash": str(row["query_hash"]),
        "query_text": str(row["query_text"]),
        "volatility": str(row["volatility"]),
        "chunks": chunks,
        "created_at": created_at,
        "ttl_seconds": ttl,
        "age_seconds": max(0, now - created_at),
        "expires_in": max(0, ttl - (now - created_at)),
        "fresh": now - created_at < ttl and len(chunks) > 0,
    }


async def get_cached_query(query: str) -> dict[str, Any] | None:
    """Return a fresh cache entry, or None. Expired rows are left as tombstones."""
    digest = query_hash(query)
    now = int(time.time())
    async with connect() as db:
        row = await (await db.execute(
            "SELECT * FROM epistemic_cache WHERE query_hash = ?", (digest,)
        )).fetchone()
    if row is None:
        return None
    entry = _cache_row(row, now)
    return entry if entry["fresh"] else None


async def put_cached_query(
    query: str,
    volatility: str,
    chunks: Iterable[dict[str, Any]],
    ttl_seconds: int,
) -> None:
    digest = query_hash(query)
    if volatility not in {"STATIC", "VOLATILE"}:
        raise ValueError("volatility must be STATIC or VOLATILE")
    now = int(time.time())
    async with connect() as db:
        await db.execute(
            """
            INSERT INTO epistemic_cache
                (query_hash, query_text, volatility, chunks_json, created_at, ttl_seconds)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(query_hash) DO UPDATE SET
                query_text = excluded.query_text,
                volatility = excluded.volatility,
                chunks_json = excluded.chunks_json,
                created_at = excluded.created_at,
                ttl_seconds = excluded.ttl_seconds
            """,
            (digest, query, volatility, json.dumps(list(chunks), ensure_ascii=False), now, ttl_seconds),
        )
        await db.commit()


async def get_cached_query_any(query: str) -> dict[str, Any] | None:
    """Read a row regardless of freshness (used by the speculation warmer)."""
    digest = query_hash(query)
    async with connect() as db:
        row = await (await db.execute(
            "SELECT * FROM epistemic_cache WHERE query_hash = ?", (digest,)
        )).fetchone()
    return _cache_row(row, int(time.time())) if row else None


# ── Promises ──────────────────────────────────────────────────────────────────


def _promise_row(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "actor": str(row["actor"]),
        "recipient": str(row["recipient"]),
        "promised_action": str(row["promised_action"]),
        "trigger_condition": str(row["trigger_condition"]),
        "watch_url": str(row["watch_url"]),
        "last_dom_hash": str(row["last_dom_hash"]),
        "priority": int(row["priority"]),
        "time_sensitivity": int(row["time_sensitivity"]),
        "status": str(row["status"]),
        "draft_artifact": row["draft_artifact"],
        "trigger_summary": row["trigger_summary"],
        "created_at": int(row["created_at"]),
    }


async def create_promise(record: dict[str, Any]) -> dict[str, Any]:
    columns = [
        "id", "actor", "recipient", "promised_action", "trigger_condition",
        "watch_url", "last_dom_hash", "priority", "time_sensitivity", "status",
        "draft_artifact", "trigger_summary", "created_at",
    ]
    values = [record.get(column) for column in columns]
    async with connect() as db:
        await db.execute(
            f"INSERT INTO caught_promises ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            values,
        )
        await db.commit()
        row = await (await db.execute(
            "SELECT * FROM caught_promises WHERE id = ?", (record["id"],)
        )).fetchone()
    if row is None:
        raise RuntimeError("promise insert succeeded but row could not be read")
    return _promise_row(row)


async def get_promise(promise_id: str) -> dict[str, Any] | None:
    async with connect() as db:
        row = await (await db.execute(
            "SELECT * FROM caught_promises WHERE id = ?", (promise_id,)
        )).fetchone()
    return _promise_row(row) if row else None


async def list_promises(include_resolved: bool = True) -> list[dict[str, Any]]:
    sql = "SELECT * FROM caught_promises"
    params: tuple[Any, ...] = ()
    if not include_resolved:
        sql += " WHERE status != ?"
        params = ("RESOLVED",)
    sql += " ORDER BY created_at DESC"
    async with connect() as db:
        rows = await (await db.execute(sql, params)).fetchall()
    return [_promise_row(row) for row in rows]


async def list_queued_promises() -> list[dict[str, Any]]:
    async with connect() as db:
        rows = await (await db.execute(
            "SELECT * FROM caught_promises WHERE status = ? ORDER BY created_at DESC",
            ("QUEUED_QUIET",),
        )).fetchall()
    return [_promise_row(row) for row in rows]


async def update_promise(promise_id: str, **fields: Any) -> dict[str, Any] | None:
    invalid = set(fields) - _PROMISE_UPDATE_COLUMNS
    if invalid:
        raise ValueError(f"refusing to update unknown promise columns: {sorted(invalid)}")
    if not fields:
        return await get_promise(promise_id)
    assignments = ", ".join(f"{column} = ?" for column in fields)
    async with connect() as db:
        await db.execute(
            f"UPDATE caught_promises SET {assignments} WHERE id = ?",
            (*fields.values(), promise_id),
        )
        await db.commit()
    return await get_promise(promise_id)


async def find_duplicate_promise(
    recipient: str, promised_action: str, watch_url: str
) -> dict[str, Any] | None:
    async with connect() as db:
        row = await (await db.execute(
            """
            SELECT * FROM caught_promises
            WHERE lower(recipient) = lower(?)
              AND promised_action = ?
              AND watch_url = ?
              AND status != 'RESOLVED'
            ORDER BY created_at DESC LIMIT 1
            """,
            (recipient, promised_action, watch_url),
        )).fetchone()
    return _promise_row(row) if row else None


async def latest_actionable_promise() -> dict[str, Any] | None:
    """Most recent promise that can still receive a simulated mutation."""
    async with connect() as db:
        row = await (await db.execute(
            """
            SELECT * FROM caught_promises
            WHERE status IN ('WATCHING', 'QUEUED_QUIET', 'NUDGED')
            ORDER BY created_at DESC LIMIT 1
            """
        )).fetchone()
    return _promise_row(row) if row else None


async def promise_counts() -> dict[str, int]:
    async with connect() as db:
        rows = await (await db.execute(
            "SELECT status, COUNT(*) AS n FROM caught_promises GROUP BY status"
        )).fetchall()
    counts = {"WATCHING": 0, "QUEUED_QUIET": 0, "NUDGED": 0, "RESOLVED": 0}
    for row in rows:
        counts[str(row["status"])] = int(row["n"])
    counts["active"] = counts["WATCHING"] + counts["QUEUED_QUIET"] + counts["NUDGED"]
    return counts


async def promises_due_for_watch() -> list[dict[str, Any]]:
    async with connect() as db:
        rows = await (await db.execute(
            """
            SELECT * FROM caught_promises
            WHERE status IN ('WATCHING', 'QUEUED_QUIET')
            ORDER BY created_at ASC
            """
        )).fetchall()
    return [_promise_row(row) for row in rows]
