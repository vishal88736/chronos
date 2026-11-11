"""Zero-prompt entity hydration and post-turn memory writeback."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

import db
from llm_client import LLMClient

logger = logging.getLogger("chronos.hydrator")

_PRONOUNS = {"he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs"}
_BOUNDARY = r"(?<![A-Za-z0-9_]){}(?![A-Za-z0-9_])"
# How many earlier questions are injected into the hydration context.
PRIOR_QUERY_LIMIT = 5


def _humanise_age(seconds: int) -> str:
    """A compact age label for the temporal memory context."""
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    if seconds < 86_400:
        return f"{seconds // 3600}h ago"
    return f"{seconds // 86_400}d ago"

_EXTRACTION_SYSTEM = """You maintain a private, local personal-context graph for a developer.
Extract only durable facts the user explicitly states about themselves, their team,
their projects, their tools, or their goals. Never store web-search facts, questions,
hypotheticals, or promises.

Return strict JSON:
{"facts": [{"key": "short canonical lowercase noun phrase", "value": "self-contained fact", "category": "identity|colleague|project|tech_stack|preference|metric|workspace"}]}

Rules:
- Keys are stable and short: "rahul", "priya", "my stack", "our target latency".
- Do not duplicate a fact already present in the supplied known context.
- At most 4 facts. If there are none, return {"facts": []}."""


@dataclass
class HydrationOutcome:
    context: str
    entities: list[dict[str, Any]] = field(default_factory=list)
    pronouns_resolved: list[str] = field(default_factory=list)
    latency_ms: int = 0
    prior_queries: list[dict[str, Any]] = field(default_factory=list)


class Hydrator:
    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    async def hydrate_detailed(self, raw_query: str) -> HydrationOutcome:
        started = time.perf_counter()
        entities = await db.get_entities()
        prior_queries = await db.recent_queries(PRIOR_QUERY_LIMIT)
        lowered = raw_query.lower()
        matched: list[dict[str, Any]] = []
        seen_keys: set[str] = set()

        # Match multiword keys first so "my stack" wins over a hypothetical "my".
        for entity in sorted(entities, key=lambda item: len(item["key"]), reverse=True):
            key = str(entity["key"])
            if key in seen_keys:
                continue
            pattern = re.compile(_BOUNDARY.format(re.escape(key)), re.IGNORECASE)
            if pattern.search(lowered):
                matched.append(entity)
                seen_keys.add(key)

        resolved_pronouns: list[str] = []
        query_tokens = set(re.findall(r"[a-z']+", lowered))
        pronoun_hits = query_tokens & _PRONOUNS
        if pronoun_hits:
            colleagues = [entity for entity in entities if entity["category"] == "colleague"]
            colleague_keys = {entity["key"] for entity in matched}
            unresolved = [entity for entity in colleagues if entity["key"] not in colleague_keys]
            if len(unresolved) == 1:
                entity = unresolved[0]
                matched.append(entity)
                seen_keys.add(entity["key"])
                for pronoun in sorted(pronoun_hits):
                    resolved_pronouns.append(f"{pronoun} → {entity['key']}")

        lines: list[str] = []
        if matched:
            lines.append(
                "Local context resolved from the user's private Chronos memory. "
                "Treat these facts as authoritative for disambiguation; do not web-search them:"
            )
            for entity in matched:
                lines.append(f"- {entity['key']}: {entity['value']} ({entity['category']})")
            if resolved_pronouns:
                lines.append(f"- pronoun resolution: {', '.join(resolved_pronouns)}")

        # The temporal half of the memory graph: what was asked before, and
        # when. A follow-up like "and what about the other one?" is only
        # answerable if the earlier question is in context.
        if prior_queries:
            lines.append(
                "Recent questions from this user, newest first. Use them only to resolve "
                "references such as 'the other one' or 'that fix'; never search for them:"
            )
            for entry in prior_queries:
                age = _humanise_age(int(time.time()) - int(entry["created_at"]))
                lines.append(f"- ({age}) {entry['message'][:220]}")

        context = "\n".join(lines) if lines else ""

        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        logger.debug("hydrated query in %dms with %d entities", latency_ms, len(matched))
        return HydrationOutcome(
            context=context,
            entities=matched,
            pronouns_resolved=resolved_pronouns,
            latency_ms=latency_ms,
            prior_queries=prior_queries,
        )

    async def hydrate_query(self, raw_query: str) -> tuple[str, list[dict[str, Any]]]:
        """Spec-compatible helper returning (enriched_context, entities)."""
        outcome = await self.hydrate_detailed(raw_query)
        return outcome.context, outcome.entities

    # ── Post-turn writeback ──────────────────────────────────────────────────

    async def extract_and_persist_entities(self, raw_query: str) -> list[dict[str, Any]]:
        """Extract durable personal facts and upsert them in the background."""
        facts = await self._llm_extract(raw_query)
        fallback_facts = self._deterministic_extract(raw_query)
        if not facts:
            facts = fallback_facts

        persisted: list[dict[str, Any]] = []
        seen: set[str] = set()
        for fact in facts:
            key = " ".join(str(fact.get("key", "")).lower().split())[:80]
            value = " ".join(str(fact.get("value", "")).split())[:800]
            category = " ".join(str(fact.get("category", "fact")).lower().split())[:40] or "fact"
            if not key or not value or key in seen or len(value) < 4:
                continue
            # Avoid turning web-search entities into personal memory.
            if any(marker in key for marker in ("http", "www.", "[", "]")):
                continue
            seen.add(key)
            try:
                persisted.append(await db.upsert_entity(key, value, category))
            except (ValueError, RuntimeError) as exc:
                logger.warning("could not persist memory entity %r: %s", key, exc)
        if persisted:
            logger.info("memory writeback persisted %d fact(s)", len(persisted))
        return persisted

    async def _llm_extract(self, raw_query: str) -> list[dict[str, str]]:
        if not self.llm.available:
            return []
        entities = await db.get_entities()
        known = "\n".join(f"- {item['key']}: {item['value']}" for item in entities)
        payload = await self.llm.complete_json(
            _EXTRACTION_SYSTEM,
            f"Known context:\n{known}\n\nLatest user message:\n{raw_query}",
            temperature=0.0,
            max_tokens=500,
            timeout=12.0,
        )
        if not isinstance(payload, dict):
            return []
        raw_facts = payload.get("facts")
        if not isinstance(raw_facts, list):
            return []
        facts: list[dict[str, str]] = []
        for fact in raw_facts[:4]:
            if not isinstance(fact, dict):
                continue
            key = str(fact.get("key", "")).strip()
            value = str(fact.get("value", "")).strip()
            category = str(fact.get("category", "fact")).strip()
            if key and value:
                facts.append({"key": key, "value": value, "category": category})
        return facts

    @staticmethod
    def _deterministic_extract(raw_query: str) -> list[dict[str, str]]:
        """Conservative regex extraction, used when the LLM is offline."""
        text = raw_query.strip()
        facts: list[dict[str, str]] = []

        colleague = re.search(
            r"\bmy\s+(teammate|colleague|friend|manager|lead)\s+"
            r"([A-Za-z][A-Za-z'\-]{1,30})\s+"
            r"(works?\s+on|leads?|owns?|is\s+working\s+on|is\s+the\s+[^,.;!?]{1,80}?\s+on)"
            r"\s+([^,.;!?]{2,120})",
            text,
            flags=re.IGNORECASE,
        )
        if colleague:
            role, name, verb, project = colleague.groups()
            name = name[:1].upper() + name[1:]
            facts.append(
                {
                    "key": name.lower(),
                    "value": f"{name} ({role.lower()} who {verb.lower()} {project.strip()})",
                    "category": "colleague",
                }
            )

        stack = re.search(
            r"\bmy\s+(?:current\s+)?(?:tech\s+)?stack\s+(?:is|uses?|includes?)\s+([^.!?]{3,220})",
            text,
            flags=re.IGNORECASE,
        )
        if stack:
            facts.append({"key": "my stack", "value": f"My stack: {stack.group(1).strip()}", "category": "tech_stack"})

        target = re.search(
            r"\bour\s+target\s+([a-z][a-z0-9 _\-]{2,40})\s+(?:is|=|at)\s+([^.!?]{2,160})",
            text,
            flags=re.IGNORECASE,
        )
        if target:
            metric, value = target.groups()
            facts.append(
                {
                    "key": f"our target {metric.strip().lower()}",
                    "value": f"Our target {metric.strip().lower()} is {value.strip()}",
                    "category": "metric",
                }
            )

        identity = re.search(r"\bmy\s+name\s+is\s+([A-Za-z][A-Za-z'\- ]{1,50})", text, flags=re.IGNORECASE)
        if identity:
            name = identity.group(1).strip()
            facts.append({"key": "my name", "value": name, "category": "identity"})

        return facts[:4]
