"""Two-stage context sieve: DOM chunks in, BM25-ranked evidence out.

This module also decides whether a DAG branch is weak enough to self-heal. The
threshold is intentionally explicit and shared with the telemetry payload.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
from dataclasses import dataclass, field
from typing import Any

from rank_bm25 import BM25Okapi

from schemas import SieveMetrics, SourceChunk

logger = logging.getLogger("chronos.sieve")

CHUNK_WORDS = 120
CHUNK_OVERLAP = 20
BM25_HEAL_THRESHOLD = 1.5
MIN_SCRAPED_WORDS = 40
MAX_CHUNKS_PER_NODE = 240
# Evidence diversity guards. Without them a single long page can supply every
# selected chunk, which wastes the context budget and makes the citation list
# look like three sources when it is really one.
MAX_CHUNKS_PER_URL = 2
MAX_CHUNKS_PER_DOMAIN = 3

# Composite reranking weights.
#   Composite = 0.60 * normalised BM25
#            + 0.25 * domain authority
#            + 0.15 * freshness
# BM25 alone treats an SEO farm the same as the vendor's own documentation,
# which is exactly the failure mode the glass-box inspector should expose.
WEIGHT_BM25 = 0.60
WEIGHT_AUTHORITY = 0.25
WEIGHT_FRESHNESS = 0.15
# The composite score tops out near 1.0 (0.60 + 0.25*0.95 + 0.15*1.0), so a
# weak-evidence line has to live on that scale rather than the old BM25 one.
COMPOSITE_HEAL_THRESHOLD = 0.55

# Primary engineering sources are worth far more than the open web.
TIER_PRIMARY = (
    "github.com",
    "developer.apple.com",
    "apple.com",
    "python.org",
    "docs.python.org",
    "fastapi.tiangolo.com",
    "mozilla.org",
    "developer.mozilla.org",
    "developer.chrome.com",
    "webkit.org",
    "docs.rs",
    "pkg.go.dev",
    "kubernetes.io",
    "react.dev",
    "nextjs.org",
    "typescriptlang.org",
    "rust-lang.org",
    "go.dev",
    "crates.io",
    "npmjs.com",
    "pypi.org",
)
TIER_INSTITUTIONAL = (".edu", ".gov", ".org", ".dev", ".io", "wikipedia.org")
TIER_AGGREGATOR = (
    "medium.com",
    "dev.to",
    "substack.com",
    "blogspot.com",
    "reddit.com",
    "quora.com",
    "news.ycombinator.com",
    "stackexchange.com",
    "stackoverflow.com",
)

# Signals that a passage is describing a *recent* state of the world.
_FRESH_TOKENS = re.compile(
    r"\b(20\d{2}|latest|current|currently|now|today|recent|recently|new|newly|"
    r"just\s+released|beta|rc\d|candidate|update[sd]?|patched|fixed|shipped|"
    r"released|deprecated|still|remains|as\s+of)\b",
    re.IGNORECASE,
)
_STALE_TOKENS = re.compile(
    r"\b(archived|deprecated|obsolete|end[- ]of[- ]life|eol|no\s+longer|"
    r"discontinued|legacy|outdated|201[0-9])\b",
    re.IGNORECASE,
)
# A passage that states a concrete version keeps its freshness score even
# without a date, because "fixed in 15.4" is a current-state claim.
_VERSION_TOKEN = re.compile(r"\bv?\d+\.\d+(?:\.\d+)?\b")


def _domain_of(url: str) -> str:
    """Bare hostname for a URL, lowercased and without a leading `www.`."""
    if not url:
        return ""
    match = re.match(r"https?://([^/:?#]+)", url.strip(), flags=re.IGNORECASE)
    if not match:
        return ""
    host = match.group(1).lower()
    return host[4:] if host.startswith("www.") else host


def authority_score(url: str) -> float:
    """Authority of a source domain in [0, 1]."""
    host = _domain_of(url)
    if not host:
        return 0.40
    if any(host == tier or host.endswith(f".{tier}") for tier in TIER_PRIMARY):
        return 0.95
    if any(host == tier or host.endswith(tier) for tier in TIER_INSTITUTIONAL):
        return 0.75
    if any(host == tier or host.endswith(f".{tier}") for tier in TIER_AGGREGATOR):
        return 0.35
    return 0.50


def freshness_score(text: str, age_seconds: int = 0) -> float:
    """How current a passage reads, in [0, 1]."""
    score = 0.55
    if _FRESH_TOKENS.search(text or ""):
        score += 0.25
    if _VERSION_TOKEN.search(text or ""):
        score += 0.10
    if _STALE_TOKENS.search(text or ""):
        score -= 0.35
    # Freshly retrieved evidence is more likely to describe the present.
    if age_seconds > 0:
        if age_seconds < 3600:
            score += 0.10
        elif age_seconds > 30 * 86_400:
            score -= 0.15
    return round(max(0.0, min(1.0, score)), 4)


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, math.ceil(len(text) / 4))


def chunk_words(text: str, size: int = CHUNK_WORDS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    words = text.split()
    if not words:
        return []
    if len(words) <= size:
        return [" ".join(words)]
    step = max(1, size - overlap)
    chunks: list[str] = []
    for start in range(0, len(words), step):
        window = words[start : start + size]
        if len(window) < 20 and chunks:
            break
        chunks.append(" ".join(window))
        if start + size >= len(words):
            break
    return chunks


@dataclass
class NodeSieveResult:
    node_id: str
    query: str
    raw_tokens: int = 0
    candidate_tokens: int = 0
    total_words: int = 0
    chunk_count: int = 0
    peak_bm25: float = 0.0
    peak_composite: float = 0.0
    needs_healing: bool = False
    healing_reason: str | None = None
    chunks: list[dict[str, Any]] = field(default_factory=list)


class ContextSieve:
    def __init__(self, threshold: float = BM25_HEAL_THRESHOLD) -> None:
        self.threshold = threshold

    def sieve_node(
        self,
        node_id: str,
        query: str,
        raw_documents: list[dict[str, Any]],
        wave: int = 1,
    ) -> NodeSieveResult:
        result = NodeSieveResult(node_id=node_id, query=query)
        if not raw_documents:
            result.needs_healing = True
            result.healing_reason = "no search results or all URL fetches timed out"
            return result

        candidates: list[dict[str, Any]] = []
        seen: set[str] = set()
        for document in raw_documents:
            text = str(document.get("text", "") or "")
            if not text.strip():
                continue
            result.raw_tokens += estimate_tokens(text)
            result.total_words += len(text.split())
            url = str(document.get("url", "") or "")
            title = str(document.get("title", "") or url or "Untitled source")
            for chunk_index, chunk in enumerate(chunk_words(text)):
                fingerprint = hashlib.md5(
                    re.sub(r"\s+", " ", chunk).strip().lower().encode("utf-8")
                ).hexdigest()
                if fingerprint in seen:
                    continue
                seen.add(fingerprint)
                candidates.append(
                    {
                        "node_id": node_id,
                        "title": title[:300],
                        "url": url,
                        "text": chunk,
                        "chunk_index": chunk_index,
                        "token_count": estimate_tokens(chunk),
                        "wave": wave,
                    }
                )
                result.candidate_tokens += estimate_tokens(chunk)
                if len(candidates) >= MAX_CHUNKS_PER_NODE:
                    break
            if len(candidates) >= MAX_CHUNKS_PER_NODE:
                break

        result.chunk_count = len(candidates)
        if result.total_words < MIN_SCRAPED_WORDS:
            result.needs_healing = True
            result.healing_reason = (
                f"only {result.total_words} scraped words (< {MIN_SCRAPED_WORDS})"
            )
        if not candidates:
            result.needs_healing = True
            result.healing_reason = result.healing_reason or "no readable text chunks"
            return result

        query_tokens = tokenize(query)
        tokenized_corpus = [tokenize(chunk["text"]) for chunk in candidates]
        usable = [index for index, tokens in enumerate(tokenized_corpus) if tokens]
        if not query_tokens or not usable:
            result.needs_healing = True
            result.healing_reason = "query or scraped text had no searchable tokens"
            result.chunks = candidates[:4]
            return result

        try:
            bm25 = BM25Okapi(tokenized_corpus)
            raw_scores = bm25.get_scores(query_tokens)
        except Exception as exc:  # noqa: BLE001 - defensive against degenerate corpora
            logger.warning("BM25 scoring failed for %s: %s", node_id, exc)
            result.needs_healing = True
            result.healing_reason = "BM25 could not score the retrieved corpus"
            result.chunks = candidates[:4]
            return result

        scored: list[dict[str, Any]] = []
        for index, candidate in enumerate(candidates):
            score = float(raw_scores[index]) if index < len(raw_scores) else 0.0
            scored.append({**candidate, "bm25_score": round(score, 4)})
        scored.sort(key=lambda chunk: float(chunk["bm25_score"]), reverse=True)
        result.peak_bm25 = round(float(scored[0]["bm25_score"]), 4) if scored else 0.0

        # Per-chunk authority and freshness, plus a per-node composite score
        # used for the healing decision. The global ranking in `assemble`
        # recomputes the composite against the cross-node BM25 maximum.
        peak = result.peak_bm25 or 0.0
        for chunk in scored:
            domain = _domain_of(str(chunk.get("url", "")))
            authority = authority_score(str(chunk.get("url", "")))
            fresh = freshness_score(str(chunk.get("text", "")))
            chunk["domain"] = domain
            chunk["authority_score"] = authority
            chunk["freshness_score"] = fresh
            normalised = (float(chunk["bm25_score"]) / peak) if peak > 0 else 0.0
            chunk["composite_score"] = round(
                WEIGHT_BM25 * normalised + WEIGHT_AUTHORITY * authority + WEIGHT_FRESHNESS * fresh,
                4,
            )
        result.peak_composite = round(
            max((float(chunk["composite_score"]) for chunk in scored), default=0.0), 4
        )
        if result.peak_composite < COMPOSITE_HEAL_THRESHOLD and not result.needs_healing:
            result.needs_healing = True
            result.healing_reason = (
                f"peak composite {result.peak_composite:.2f} < threshold {COMPOSITE_HEAL_THRESHOLD:.2f}"
            )
        if result.peak_bm25 < self.threshold and not result.needs_healing:
            result.needs_healing = True
            result.healing_reason = (
                f"peak BM25 {result.peak_bm25:.2f} < threshold {self.threshold:.2f}"
            )

        # Keep enough per-node evidence to survive global dedupe without
        # flooding the final LLM context.
        positive = [chunk for chunk in scored if float(chunk["bm25_score"]) > 0]
        result.chunks = (positive or scored)[:5]
        return result

    def assemble(self, results: list[NodeSieveResult], limit: int = 8) -> SieveMetrics:
        all_chunks: list[dict[str, Any]] = []
        seen_text: set[str] = set()
        raw_doc_tokens = sum(result.raw_tokens for result in results)
        normalized_tokens = sum(result.candidate_tokens for result in results)
        total_words = sum(result.total_words for result in results)
        for result in results:
            for chunk in result.chunks:
                fingerprint = hashlib.md5(
                    re.sub(r"\s+", " ", str(chunk["text"])).strip().lower().encode("utf-8")
                ).hexdigest()
                if fingerprint in seen_text:
                    continue
                seen_text.add(fingerprint)
                all_chunks.append(chunk)
        all_chunks.sort(key=lambda chunk: float(chunk.get("bm25_score", 0.0)), reverse=True)

        # Normalise BM25 across the whole corpus, then fold in domain
        # authority and freshness. This is the ranking the inspector reports
        # and the ranking the answer is grounded in.
        peak_bm25 = max((float(chunk.get("bm25_score", 0.0)) for chunk in all_chunks), default=0.0)
        for chunk in all_chunks:
            url = str(chunk.get("url", "") or "")
            chunk.setdefault("domain", _domain_of(url))
            chunk.setdefault("authority_score", authority_score(url))
            chunk.setdefault("freshness_score", freshness_score(str(chunk.get("text", ""))))
            normalised = (
                float(chunk.get("bm25_score", 0.0)) / peak_bm25 if peak_bm25 > 0 else 0.0
            )
            chunk["composite_score"] = round(
                WEIGHT_BM25 * normalised
                + WEIGHT_AUTHORITY * float(chunk.get("authority_score", 0.0))
                + WEIGHT_FRESHNESS * float(chunk.get("freshness_score", 0.0)),
                4,
            )
        all_chunks.sort(key=lambda chunk: float(chunk.get("composite_score", 0.0)), reverse=True)

        # Prefer diverse evidence over near-duplicate overlapping chunks. This
        # prevents one verbose source from consuming the entire 8-chunk budget.
        selected: list[dict[str, Any]] = []
        selected_token_sets: list[set[str]] = []
        selected_urls: list[str] = []
        url_counts: dict[str, int] = {}
        domain_counts: dict[str, int] = {}
        for chunk in all_chunks:
            url = str(chunk.get("url", "") or "")
            domain = _domain_of(url)
            if url and url_counts.get(url, 0) >= MAX_CHUNKS_PER_URL:
                continue
            if domain and domain_counts.get(domain, 0) >= MAX_CHUNKS_PER_DOMAIN:
                continue
            tokens = set(tokenize(str(chunk["text"])))
            too_similar = False
            for index, existing in enumerate(selected_token_sets):
                if not tokens or not existing:
                    continue
                overlap = len(tokens & existing) / max(1, min(len(tokens), len(existing)))
                if overlap > 0.62:
                    too_similar = True
                    break
                # Chunks from the same document overlap heavily by construction.
                # Jaccard catches that near-duplication even when the chunking
                # window keeps the raw overlap ratio below the ratio test.
                if url and url == selected_urls[index]:
                    union = len(tokens | existing)
                    if union and len(tokens & existing) / union > 0.34:
                        too_similar = True
                        break
            if too_similar:
                continue
            selected.append(chunk)
            selected_token_sets.append(tokens)
            selected_urls.append(url)
            if url:
                url_counts[url] = url_counts.get(url, 0) + 1
            if domain:
                domain_counts[domain] = domain_counts.get(domain, 0) + 1
            if len(selected) >= limit:
                break

        sources: list[SourceChunk] = []
        for index, chunk in enumerate(selected, start=1):
            sources.append(
                SourceChunk(
                    id=f"src_{index}",
                    node_id=str(chunk["node_id"]),
                    title=str(chunk["title"])[:300],
                    url=str(chunk["url"]),
                    text=str(chunk["text"]),
                    bm25_score=round(float(chunk.get("bm25_score", 0.0)), 4),
                    token_count=int(chunk.get("token_count", estimate_tokens(str(chunk["text"])))),
                    domain=str(chunk.get("domain", "")),
                    authority_score=round(float(chunk.get("authority_score", 0.0)), 4),
                    freshness_score=round(float(chunk.get("freshness_score", 0.0)), 4),
                    composite_score=round(float(chunk.get("composite_score", 0.0)), 4),
                    wave=int(chunk.get("wave", 1) or 1),
                )
            )
        sieved_tokens = sum(source.token_count for source in sources)
        raw_tokens = max(raw_doc_tokens, normalized_tokens, sieved_tokens)
        compression = 0.0
        if raw_tokens > 0:
            compression = max(0.0, min(100.0, round((1 - sieved_tokens / raw_tokens) * 100, 1)))
        peak = round(max((result.peak_bm25 for result in results), default=0.0), 4)
        peak_composite = round(
            max((float(source.composite_score) for source in sources), default=0.0), 4
        )
        metrics = SieveMetrics(
            raw_tokens=raw_tokens,
            sieved_tokens=sieved_tokens,
            compression_pct=compression,
            peak_bm25=peak,
            raw_chunks=sum(result.chunk_count for result in results),
            selected_chunks=len(sources),
            total_scraped_words=total_words,
            sources=sources,
            peak_composite_score=peak_composite,
        )
        logger.info(
            "sieve: raw=%d sieved=%d compression=%.1f%% peak_bm25=%.2f peak_composite=%.2f",
            raw_tokens,
            sieved_tokens,
            compression,
            peak,
            peak_composite,
        )
        return metrics
