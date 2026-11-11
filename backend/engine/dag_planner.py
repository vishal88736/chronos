"""Speculative DAG decomposition and failed-branch query rewriting."""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from schemas import DAGNode, DAGPlan, Volatility
from llm_client import LLMClient

logger = logging.getLogger("chronos.planner")

_PLANNER_SYSTEM = """You are the query planner inside Chronos, a low-latency research engine.
Decompose the user's request into a small Directed Acyclic Graph of 2 to 4 web-search
sub-queries. Respond with strict JSON only:

{"nodes": [{"id": "q1", "query": "...", "depends_on": [], "volatility": "STATIC|VOLATILE"}]}

Rules:
- Use 2 independent nodes whenever different sources can answer in parallel.
- Add a dependency only when a later query genuinely needs the result of an earlier one.
- Never include the user's private promise or personal context in a web query.
- VOLATILE = live versions, releases, prices, availability, current status, recent news.
- STATIC = documentation, benchmark methodology, historical issues, settled facts.
- Queries must be concise, standalone, and search-engine friendly.
- ids must be q1, q2, q3, q4 or similar alphanumeric identifiers."""

_REWRITE_SYSTEM = """You broaden failed web-search queries. A query returned either no URLs
or only irrelevant/low-scoring text. Rewrite it once as a simpler, broader search query
that is likely to surface an authoritative overview, developer discussion, or workaround.
Remove quotes, site restrictions, rare long-tail qualifiers and redundant words.
Return only JSON: {"query": "rewritten query"}."""

_COMMUNITY_SUFFIX = "GitHub developer discussion workaround"
_OFFICIAL_SUFFIX = "official release notes status"
_BENCH_SUFFIX = "tail latency benchmark results"
_FOLLOWUP_SUFFIX = "changelog fix details"

_STOPWORDS = {
    "a", "an", "the", "of", "for", "to", "in", "on", "at", "and", "or", "is", "are",
    "was", "were", "be", "been", "with", "from", "by", "as", "it", "this", "that",
    "these", "those", "our", "my", "your", "we", "i", "me", "please", "could", "would",
    "can", "if", "whether", "check", "find", "search", "look", "up", "tell",
}

# Version-looking tokens such as "15.4", "v3.2.1" or "2024.1".
_VERSION_TOKEN = re.compile(r"\bv?\d+\.\d+(?:\.\d+)?\b", re.IGNORECASE)
# Words that are never interesting as a search subject on their own.
_TOPIC_NOISE = {
    "issue", "issues", "pull", "request", "pr", "readme", "docs", "documentation",
    "release", "releases", "notes", "changelog", "status", "official", "developer",
    "developers", "discussion", "workaround", "github", "gitlab", "stack", "overflow",
    "version", "versions", "latest", "current", "update", "updates", "question",
    "questions", "answer", "answers", "blog", "post", "guide", "tutorial", "how",
    "what", "why", "when", "where", "which", "does", "can", "you", "your", "app",
}

_VOLATILE_PATTERN = re.compile(
    r"\b(latest|current|currently|today|now|news|release[sd]?|version|beta|rc|"
    r"fixed|patched|patch|price|pricing|status|available|availability|update[sd]?|"
    r"deprecated|breaking|just shipped|when)\b",
    re.IGNORECASE,
)


class DAGPlanner:
    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    async def plan(
        self,
        raw_query: str,
        hydrated_context: str,
        matched_entities: list[dict[str, Any]],
    ) -> tuple[DAGPlan, str, int]:
        """Return (validated_plan, planner_kind, elapsed_ms)."""
        started = time.perf_counter()
        if self.llm.available:
            payload = await self.llm.complete_json(
                _PLANNER_SYSTEM,
                self._planner_prompt(raw_query, hydrated_context),
                temperature=0.1,
                max_tokens=700,
                timeout=18.0,
            )
            plan = self._validate_llm_plan(payload, raw_query)
            if plan is not None:
                elapsed = max(1, int((time.perf_counter() - started) * 1000))
                logger.info("LLM planned %d DAG nodes in %dms", len(plan.nodes), elapsed)
                return plan, "llm", elapsed

        plan = self.deterministic_plan(raw_query, matched_entities)
        elapsed = max(1, int((time.perf_counter() - started) * 1000))
        logger.info("deterministic planner produced %d DAG nodes in %dms", len(plan.nodes), elapsed)
        return plan, "deterministic", elapsed

    @staticmethod
    def _planner_prompt(raw_query: str, hydrated_context: str) -> str:
        context = hydrated_context or "No local entities matched."
        return (
            f"USER REQUEST:\n{raw_query}\n\n"
            f"RESOLVED LOCAL CONTEXT (for disambiguation only; never quote in queries):\n{context}\n\n"
            "Produce the JSON DAG now. Do not include markdown."
        )

    @staticmethod
    def _validate_llm_plan(payload: Any, raw_query: str) -> DAGPlan | None:
        if isinstance(payload, list):
            payload = {"nodes": payload}
        if not isinstance(payload, dict) or not isinstance(payload.get("nodes"), list):
            return None
        raw_nodes = payload["nodes"][:4]
        cleaned: list[dict[str, Any]] = []
        used_ids: set[str] = set()
        for index, raw_node in enumerate(raw_nodes):
            if not isinstance(raw_node, dict):
                continue
            query = " ".join(str(raw_node.get("query", "")).split())
            if len(query) < 3:
                continue
            node_id = re.sub(r"[^a-zA-Z0-9_]", "", str(raw_node.get("id", "")))[:48]
            if not node_id or node_id in used_ids:
                node_id = f"q{index + 1}"
            while node_id in used_ids:
                node_id = f"{node_id}x"[:48]
            used_ids.add(node_id)
            volatility = str(raw_node.get("volatility", "")).upper()
            if volatility not in {"STATIC", "VOLATILE"}:
                volatility = "VOLATILE" if _VOLATILE_PATTERN.search(query) else "STATIC"
            depends_on = raw_node.get("depends_on", [])
            if not isinstance(depends_on, list):
                depends_on = []
            cleaned.append(
                {
                    "id": node_id,
                    "query": query[:600],
                    "depends_on": [str(dep) for dep in depends_on if str(dep) in used_ids],
                    "volatility": volatility,
                }
            )
        # Remove dependencies that point forward or to later-renamed nodes.
        ids = {node["id"] for node in cleaned}
        for node in cleaned:
            node["depends_on"] = [dep for dep in node["depends_on"] if dep in ids and dep != node["id"]]
        try:
            plan = DAGPlan.model_validate({"nodes": cleaned})
        except ValueError as exc:
            logger.warning("discarding invalid LLM DAG: %s", exc)
            return None
        if not raw_query.strip():
            return None
        return plan

    def deterministic_plan(
        self,
        raw_query: str,
        matched_entities: list[dict[str, Any]] | None = None,
    ) -> DAGPlan:
        """A real fallback planner used whenever no LLM is configured or output is invalid."""
        core = clean_for_search(raw_query)
        if not core:
            core = " ".join(raw_query.split())[:220] or "technology news"

        comparison = re.match(
            r"^(?:compare\s+)?(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\s+(?:tail\s+latency|latency|benchmarks?|performance|throughput).*)?$",
            core,
            flags=re.IGNORECASE,
        )
        if comparison:
            left = comparison.group(1).strip(" .,-")
            right = comparison.group(2).strip(" .,-")
            right = re.split(
                r"\s+(?:tail\s+latency|latency|benchmarks?|performance|throughput)\b",
                right,
                maxsplit=1,
                flags=re.IGNORECASE,
            )[0].strip(" .,-")
            nodes = [
                DAGNode(id="q1", query=f"{left} {_BENCH_SUFFIX}", volatility=Volatility.STATIC),
                DAGNode(id="q2", query=f"{right} {_BENCH_SUFFIX}", volatility=Volatility.STATIC),
            ]
            return DAGPlan(nodes=nodes)

        volatility = Volatility.VOLATILE if _VOLATILE_PATTERN.search(core) else Volatility.STATIC
        primary = self._with_suffix(core, _OFFICIAL_SUFFIX if volatility is Volatility.VOLATILE else _COMMUNITY_SUFFIX)
        secondary = self._with_suffix(core, _COMMUNITY_SUFFIX if volatility is Volatility.VOLATILE else _OFFICIAL_SUFFIX)
        if primary.lower() == secondary.lower():
            secondary = self._with_suffix(core, "independent analysis")
        nodes = [
            DAGNode(id="q1", query=primary, volatility=volatility),
            DAGNode(id="q2", query=secondary, volatility=Volatility.STATIC),
        ]
        return DAGPlan(nodes=nodes)

    @staticmethod
    def _with_suffix(core: str, suffix: str) -> str:
        words = core.split()
        # Keep the head of very long queries but retain the high-signal tail.
        core_limited = " ".join(words[:24]) if len(words) > 36 else core
        return f"{core_limited.rstrip(' ?.!')} {suffix}"[:600]

    def predict_queries(
        self, partial_text: str, matched_entities: list[dict[str, Any]] | None = None
    ) -> list[str]:
        """Fast, no-network candidate subqueries for the 400ms speculation loop."""
        cleaned = partial_text.strip()
        if len(cleaned) < 3:
            return []
        plan = self.deterministic_plan(cleaned, matched_entities)
        return [node.query for node in plan.nodes[:2]]

    async def rewrite_node(self, node: DAGNode, reason: str) -> DAGNode:
        """Create a broadened `_retry` node, fixing a failed/low-yield branch."""
        rewritten = ""
        if self.llm.available:
            payload = await self.llm.complete_json(
                _REWRITE_SYSTEM,
                f"Failed query: {node.query}\nFailure reason: {reason}\nReturn the broader JSON query.",
                temperature=0.2,
                max_tokens=200,
                timeout=8.0,
            )
            if isinstance(payload, dict):
                candidate = " ".join(str(payload.get("query", "")).split())
                if 3 <= len(candidate) <= 600:
                    rewritten = candidate
        if not rewritten:
            rewritten = self._heuristic_rewrite(node.query)
        retry_id = f"{node.id[:38]}_retry"
        return DAGNode(
            id=retry_id,
            query=rewritten,
            depends_on=[node.id],
            volatility=node.volatility,
            retry_of=node.id,
            wave=node.wave,
        )

    # ── Wave 2: dependent follow-up queries ──────────────────────────────────

    async def build_followup(
        self,
        raw_query: str,
        wave_one: list[DAGNode],
        wave_one_chunks: list[dict[str, Any]],
        ambient_terms: list[str] | None = None,
    ) -> DAGNode | None:
        """Build a wave-2 node that interpolates the wave-1 findings.

        Wave 1 resolves the unknown parts of the question in parallel. Wave 2
        takes what wave 1 actually found — a version number, a product name,
        the authoritative domain — and asks a sharper follow-up that could not
        have been written before wave 1 ran.
        """
        if not wave_one:
            return None

        version = self._dominant_version(wave_one_chunks)
        subject = self._subject_terms(raw_query)
        if not subject:
            return None

        detail = version or (wave_one_chunks[0].get("domain", "") if wave_one_chunks else "")
        parts = subject[:4]
        if version:
            parts.append(version)
        if ambient_terms:
            parts.extend(term for term in ambient_terms[:2] if term.lower() not in " ".join(parts).lower())
        query = " ".join(parts)[:520]
        query = f"{query} {_FOLLOWUP_SUFFIX}".strip()[:600]
        if len(query) < 8:
            return None

        volatility = Volatility.VOLATILE if version else Volatility.STATIC
        depends = [node.id for node in wave_one][:3]
        return DAGNode(
            id="q_wave2",
            query=query,
            depends_on=depends,
            volatility=volatility,
            wave=2,
        )

    @staticmethod
    def _dominant_version(chunks: list[dict[str, Any]]) -> str:
        """The version string that appears most often across the evidence."""
        counts: dict[str, int] = {}
        for chunk in chunks[:12]:
            text = str(chunk.get("text", ""))[:1200]
            for match in _VERSION_TOKEN.findall(text):
                token = match.strip().lstrip("vV")
                if len(token) < 3 or token.startswith("0"):
                    continue
                counts[token] = counts.get(token, 0) + 1
        if not counts:
            return ""
        return max(counts.items(), key=lambda item: (item[1], -len(item[0])))[0]

    @staticmethod
    def _subject_terms(raw_query: str) -> list[str]:
        """The nouns that describe what the question is actually about."""
        core = clean_for_search(raw_query) or raw_query
        words = re.findall(r"[A-Za-z][A-Za-z0-9.+#-]{2,}", core)
        kept: list[str] = []
        for word in words:
            lowered = word.lower()
            if lowered in _STOPWORDS or lowered in _TOPIC_NOISE:
                continue
            if len(lowered) <= 2:
                continue
            if lowered not in [item.lower() for item in kept]:
                kept.append(word)
        return kept[:6]

    @staticmethod
    def _heuristic_rewrite(query: str) -> str:
        words = re.findall(r"[\w.+#-]+", query.lower())
        meaningful = [word for word in words if word not in _STOPWORDS and len(word) > 1]
        deduped: list[str] = []
        for word in meaningful:
            if word not in deduped:
                deduped.append(word)
        base = " ".join(deduped[:12]).strip()
        if not base:
            base = query[:120]
        if not re.search(r"\b(forum|discussion|overview|workaround|issue)\b", base):
            base = f"{base} developer discussion workaround"
        return base[:600]


def clean_for_search(raw_query: str) -> str:
    """Remove commitment/conditional chatter and imperative wrappers from a query."""
    text = " ".join(raw_query.split())
    if not text:
        return ""

    # Split at em/en dashes and sentence boundaries, then discard personal,
    # promise-like clauses. This is deliberately conservative: we keep whatever
    # remains of the actual research question.
    fragments = re.split(r"\s*[—–]\s*|(?<=[.!?])\s+", text)
    research_fragments: list[str] = []
    for fragment in fragments:
        lowered = fragment.lower()
        if re.search(
            r"\b(i\s+promised|i['’]ll\b|i\s+will\b|i\s+need\s+to\b|remind\s+me|"
            r"i\s+should\b|i['’]m\s+going\s+to|let\s+me\s+know\s+when|"
            r"once\s+(?:it|that|apple|they|he|she)\b|after\s+that\s+i\b)",
            lowered,
        ):
            continue
        if fragment.strip():
            research_fragments.append(fragment.strip())

    core = " ".join(research_fragments).strip(" .,;:—–-")
    if not core:
        core = text
    core = re.sub(
        r"^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?"
        r"(?:check|find\s+out|search(?:\s+for)?|look\s+up|tell\s+me|verify|see)"
        r"\s+(?:if|whether|that|about)?\s*",
        "",
        core,
        flags=re.IGNORECASE,
    ).strip(" .,;:—–-")
    core = re.sub(r"^compare\s+", "", core, flags=re.IGNORECASE).strip()
    # Remove a dangling conjunction left behind by clause removal.
    core = re.sub(r"\s+(and|but|while|because|so)\s*$", "", core, flags=re.IGNORECASE).strip()
    if len(core) > 320:
        core = " ".join(core.split()[:48])
    return core
