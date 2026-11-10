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
    total_words: int = 0
    chunk_count: int = 0
    peak_bm25: float = 0.0
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
                    }
                )
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
        raw_tokens = sum(result.raw_tokens for result in results)
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
        selected = all_chunks[:limit]
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
                )
            )
        sieved_tokens = sum(source.token_count for source in sources)
        compression = 0.0
        if raw_tokens > 0:
            compression = max(0.0, min(100.0, round((1 - sieved_tokens / raw_tokens) * 100, 1)))
        peak = round(max((result.peak_bm25 for result in results), default=0.0), 4)
        metrics = SieveMetrics(
            raw_tokens=raw_tokens,
            sieved_tokens=sieved_tokens,
            compression_pct=compression,
            peak_bm25=peak,
            raw_chunks=sum(result.chunk_count for result in results),
            selected_chunks=len(sources),
            total_scraped_words=total_words,
            sources=sources,
        )
        logger.info(
            "sieve: raw=%d sieved=%d compression=%.1f%% peak_bm25=%.2f",
            raw_tokens,
            sieved_tokens,
            compression,
            peak,
        )
        return metrics
