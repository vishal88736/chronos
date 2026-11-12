"""Async SQLite persistence for Chronos.

Five tables, created idempotently on startup:
  * memory_entities       — the local personal context graph
  * epistemic_cache       — TTL-scoped, volatility-aware retrieval cache
  * caught_promises       — the out-of-band promise vault
  * outbound_activity_log — outbound completion signals used by auto-verification
  * query_history         — recent user prompts used for temporal hydration

Every connection is short-lived and WAL-enabled, which keeps the background
promise daemon from blocking a streaming chat request.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Iterable

import aiosqlite
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

logger = logging.getLogger("chronos.db")

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
    status TEXT NOT NULL, -- 'WATCHING', 'QUEUED_QUIET', 'NUDGED', 'AUTO_VERIFIED_SILENT', 'RESOLVED'
    draft_artifact TEXT,
    trigger_summary TEXT,
    created_at INTEGER NOT NULL,
    verification_note TEXT,
    urgency_score REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbound_activity_log (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'generic',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS query_history (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    focus_level INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promises_status ON caught_promises(status);
CREATE INDEX IF NOT EXISTS idx_cache_created_at ON epistemic_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON outbound_activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_query_history_created_at ON query_history(created_at);
"""

# Columns added after the first release. Existing databases are migrated in
# place on startup so a long-lived local install keeps its promises.
MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    ("caught_promises", "verification_note", "TEXT"),
    ("caught_promises", "urgency_score", "REAL NOT NULL DEFAULT 0"),
)

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
    "verification_note",
    "urgency_score",
}


@asynccontextmanager
async def connect() -> AsyncIterator[aiosqlite.Connection]:
    """Open a tuned, short-lived connection with dict-like rows.

    `journal_mode` is persistent in the database file, so it is applied once
    during `init_db` instead of on every connection. Re-issuing it per
    connection took a write lock on every read and was a needless source of
    "database is locked" contention between the watcher and a live stream.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA busy_timeout=5000")
        await db.execute("PRAGMA synchronous=NORMAL")
        yield db


async def init_db() -> None:
    """Create the schema and seed the context graph exactly once."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with connect() as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.executescript(SCHEMA)
        await _migrate(db)
        count_row = await (await db.execute("SELECT COUNT(*) AS n FROM memory_entities")).fetchone()
        if count_row is not None and int(count_row["n"]) == 0:
            now = int(time.time())
            await db.executemany(
                "INSERT INTO memory_entities (key, value, category, updated_at) VALUES (?, ?, ?, ?)",
                [(key, value, category, now) for key, value, category in SEED_ENTITIES],
            )
        await db.commit()
    await purge_expired_cache()


async def _migrate(db: aiosqlite.Connection) -> None:
    """Add columns that newer releases introduced to older databases."""
    for table, column, definition in MIGRATIONS:
        rows = await (await db.execute(f"PRAGMA table_info({table})")).fetchall()
        if any(str(row["name"]) == column for row in rows):
            continue
        try:
            await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            logger.info("migrated %s.%s", table, column)
        except Exception as exc:  # noqa: BLE001 - migration must never block startup
            logger.warning("could not migrate %s.%s: %s", table, column, exc)


def normalize_query(query: str) -> str:
    """Normalize for stable semantic-ish cache keys and BM25 queries."""
    lowered = query.lower().strip()
    collapsed = re.sub(r"[^\w]+", " ", lowered, flags=re.UNICODE)
    return " ".join(collapsed.split())


def query_hash(query: str, volatility: str = "VOLATILE") -> str:
    """Cache key for a query.

    Volatility is part of the key on purpose. A STATIC answer is allowed to
    live for a day while a VOLATILE one expires in minutes, so the two can
    never share a row — otherwise a fresh-looking STATIC entry would be served
    to a query that explicitly asked for live data, and vice versa.
    """
    normalized = f"{volatility.strip().upper()}|{normalize_query(query)}"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


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


async def get_cached_query(query: str, volatility: str = "VOLATILE") -> dict[str, Any] | None:
    """Return a fresh cache entry for this query+volatility, or None."""
    digest = query_hash(query, volatility)
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
    if volatility not in {"STATIC", "VOLATILE"}:
        raise ValueError("volatility must be STATIC or VOLATILE")
    digest = query_hash(query, volatility)
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


async def get_cached_query_any(query: str, volatility: str = "VOLATILE") -> dict[str, Any] | None:
    """Read a row regardless of freshness (used by the speculation warmer)."""
    digest = query_hash(query, volatility)
    async with connect() as db:
        row = await (await db.execute(
            "SELECT * FROM epistemic_cache WHERE query_hash = ?", (digest,)
        )).fetchone()
    return _cache_row(row, int(time.time())) if row else None


async def purge_expired_cache() -> int:
    """Delete rows whose TTL has elapsed. Returns the number removed.

    Expired entries used to be left behind as tombstones, which grew the
    database without bound and made every cache lookup slower over time.
    """
    now = int(time.time())
    async with connect() as db:
        cursor = await db.execute(
            "DELETE FROM epistemic_cache WHERE created_at + ttl_seconds <= ?", (now,)
        )
        deleted = cursor.rowcount or 0
        await db.commit()
    if deleted:
        logger.info("purged %d expired epistemic cache row(s)", deleted)
    return int(deleted)


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
        "verification_note": row["verification_note"],
        "urgency_score": round(float(row["urgency_score"] or 0.0), 2),
    }


async def create_promise(record: dict[str, Any]) -> dict[str, Any]:
    columns = [
        "id", "actor", "recipient", "promised_action", "trigger_condition",
        "watch_url", "last_dom_hash", "priority", "time_sensitivity", "status",
        "draft_artifact", "trigger_summary", "created_at",
        "verification_note", "urgency_score",
    ]
    values = [record.get(column) for column in columns]
    # urgency_score is NOT NULL; a record that predates the column simply has
    # no computed urgency yet.
    urgency_index = columns.index("urgency_score")
    if values[urgency_index] is None:
        values[urgency_index] = 0.0
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
    """Find an equivalent, still-open promise.

    The comparison is case-insensitive: the same commitment phrased with
    different capitalisation is still the same commitment, and treating it as
    new would spawn a second watcher on the same page.
    """
    async with connect() as db:
        row = await (await db.execute(
            """
            SELECT * FROM caught_promises
            WHERE lower(recipient) = lower(?)
              AND lower(promised_action) = lower(?)
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
    counts = {
        "WATCHING": 0,
        "QUEUED_QUIET": 0,
        "NUDGED": 0,
        "AUTO_VERIFIED_SILENT": 0,
        "RESOLVED": 0,
    }
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


# ── Outbound activity log ─────────────────────────────────────────────────────
#
# The promise daemon reads this before it ever interrupts the user. If the
# action the user promised to take already shows up here, the nudge is
# suppressed and the promise is closed silently.


def _activity_row(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "summary": str(row["summary"]),
        "kind": str(row["kind"] or "generic"),
        "created_at": int(row["created_at"]),
    }


async def log_outbound_activity(
    summary: str, kind: str = "generic", created_at: int | None = None
) -> dict[str, Any]:
    clean = " ".join(str(summary).split())[:600]
    if not clean:
        raise ValueError("activity summary is required")
    entry = {
        "id": f"act_{uuid.uuid4().hex[:12]}",
        "summary": clean,
        "kind": " ".join(str(kind or "generic").split())[:40] or "generic",
        "created_at": int(created_at if created_at is not None else time.time()),
    }
    async with connect() as db:
        await db.execute(
            """
            INSERT INTO outbound_activity_log (id, summary, kind, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (entry["id"], entry["summary"], entry["kind"], entry["created_at"]),
        )
        await db.commit()
    return entry


async def list_outbound_activity(limit: int = 50) -> list[dict[str, Any]]:
    async with connect() as db:
        rows = await (await db.execute(
            "SELECT * FROM outbound_activity_log ORDER BY created_at DESC LIMIT ?",
            (max(1, min(int(limit), 500)),),
        )).fetchall()
    return [_activity_row(row) for row in rows]


async def recent_outbound_activity(
    recipient: str = "", promised_action: str = "", within_seconds: int = 86_400
) -> list[dict[str, Any]]:
    """Activity entries that could plausibly prove a promise was fulfilled.

    The match is deliberately generous: a commit, a PR, a message or a file
    edit that mentions the recipient or a distinctive fragment of the promised
    action counts. The cost of a false negative (nagging a user who already
    did the thing) is much higher than a false positive, because the gate
    below still requires the promise to be genuinely actionable.
    """
    entries = await list_outbound_activity(limit=200)
    cutoff = int(time.time()) - max(60, int(within_seconds))
    recipient_tokens = {
        token for token in re.findall(r"[a-z0-9]+", recipient.lower()) if len(token) > 2
    }
    action_tokens = {
        token
        for token in re.findall(r"[a-z0-9]+", promised_action.lower())
        if len(token) > 3 and token not in {"send", "share", "update", "with", "that", "this", "will"}
    }
    matches: list[dict[str, Any]] = []
    for entry in entries:
        if entry["created_at"] < cutoff:
            continue
        haystack = entry["summary"].lower()
        entry_tokens = set(re.findall(r"[a-z0-9]+", haystack))
        if recipient_tokens and recipient_tokens & entry_tokens:
            matches.append(entry)
            continue
        if action_tokens:
            overlap = len(action_tokens & entry_tokens) / len(action_tokens)
            if overlap >= 0.6:
                matches.append(entry)
    return matches


# ── Query history ────────────────────────────────────────────────────────────
#
# The temporal half of the memory graph. A follow-up question like "and what
# about the other one?" is meaningless without knowing what was asked before
# it and how long ago.


def _query_row(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "message": str(row["message"]),
        "focus_level": int(row["focus_level"]),
        "created_at": int(row["created_at"]),
    }


async def record_query(message: str, focus_level: int = 2) -> dict[str, Any]:
    """Store a turn's question with its timestamp."""
    clean = " ".join(str(message).split())[:2000]
    if not clean:
        raise ValueError("query message is required")
    entry = {
        "id": f"q_{uuid.uuid4().hex[:12]}",
        "message": clean,
        "focus_level": int(focus_level or 2),
        "created_at": int(time.time()),
    }
    async with connect() as db:
        await db.execute(
            """
            INSERT INTO query_history (id, message, focus_level, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (entry["id"], entry["message"], entry["focus_level"], entry["created_at"]),
        )
        await db.commit()
    return entry


async def recent_queries(limit: int = 5) -> list[dict[str, Any]]:
    """The most recent distinct questions, newest first.

    Asking the same thing twice is one topic, not two, so identical
    messages collapse to their newest occurrence.
    """
    async with connect() as db:
        rows = await (await db.execute(
            "SELECT * FROM query_history ORDER BY created_at DESC LIMIT ?",
            (max(1, min(int(limit), 50)) * 4,),
        )).fetchall()
    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    for row in rows:
        entry = _query_row(row)
        key = entry["message"].lower()
        if key in seen:
            continue
        seen.add(key)
        results.append(entry)
        if len(results) >= limit:
            break
    return results


async def prune_query_history(keep: int = 50) -> int:
    """Drop the oldest questions beyond the retention window."""
    async with connect() as db:
        cursor = await db.execute(
            """
            DELETE FROM query_history WHERE id NOT IN (
                SELECT id FROM query_history ORDER BY created_at DESC LIMIT ?
            )
            """,
            (max(1, int(keep)),),
        )
        deleted = cursor.rowcount or 0
        await db.commit()
    return int(deleted)
