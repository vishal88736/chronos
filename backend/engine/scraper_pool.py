"""Fault-tolerant search adapters, hedged URL scraping and epistemic caching.

Providers are attempted concurrently when premium keys exist. DuckDuckGo is the
zero-key default. Every URL has a hard 1.8s budget; a failed scrape contributes
its search snippet rather than failing the DAG node.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import socket
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from bs4 import BeautifulSoup

import db
from schemas import Volatility

logger = logging.getLogger("chronos.scraper")

STATIC_TTL_SECONDS = 86_400
VOLATILE_TTL_SECONDS = 300
MAX_SEARCH_RESULTS = 4
MAX_PAGE_BYTES = 1_300_000

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
_BASE_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
}


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    provider: str


@dataclass
class RetrievalResult:
    chunks: list[dict[str, Any]]
    cached: bool
    latency_ms: int
    provider: str
    urls_attempted: int
    errors: list[str] = field(default_factory=list)
    cache_age_seconds: int = 0
    search_results: int = 0


class ScraperPool:
    def __init__(self) -> None:
        self.tavily_key = (os.getenv("TAVILY_API_KEY") or "").strip()
        self.serper_key = (os.getenv("SERPER_API_KEY") or "").strip()
        timeout_ms = int(os.getenv("SEARCH_TIMEOUT_MS", "1800"))
        self.url_timeout = max(0.5, min(timeout_ms / 1000.0, 5.0))
        logger.info(
            "search providers: tavily=%s serper=%s duckduckgo=true timeout=%.1fs",
            bool(self.tavily_key),
            bool(self.serper_key),
            self.url_timeout,
        )

    def public_info(self) -> dict[str, bool]:
        return {
            "tavily": bool(self.tavily_key),
            "serper": bool(self.serper_key),
            "duckduckgo_fallback": True,
        }

    async def search_and_scrape(
        self, query: str, volatility: Volatility | str
    ) -> RetrievalResult:
        started = time.perf_counter()
        vol = volatility.value if isinstance(volatility, Volatility) else volatility
        ttl = STATIC_TTL_SECONDS if vol == "STATIC" else VOLATILE_TTL_SECONDS

        cached = await db.get_cached_query(query)
        if cached is not None:
            latency = max(1, int((time.perf_counter() - started) * 1000))
            logger.info("epistemic cache hit for %r (%ds old)", query[:70], cached["age_seconds"])
            return RetrievalResult(
                chunks=list(cached["chunks"]),
                cached=True,
                latency_ms=latency,
                provider="epistemic_cache",
                urls_attempted=0,
                cache_age_seconds=int(cached["age_seconds"]),
                search_results=len(cached["chunks"]),
            )

        results, provider, search_errors = await self._search_with_fallback(query)
        raw_chunks: list[dict[str, Any]] = []
        scrape_errors: list[str] = []
        urls_attempted = 0

        if results:
            urls_attempted = len(results)
            fetched = await self._scrape_results(results, query)
            for result, page in zip(results, fetched):
                text = page.get("text") or result.snippet
                if not text or len(text.split()) < 8:
                    scrape_errors.append(f"{result.url}: empty content")
                    continue
                raw_chunks.append(
                    {
                        "title": page.get("title") or result.title,
                        "url": result.url,
                        "text": text,
                        "provider": result.provider,
                        "fetched": bool(page.get("text")),
                    }
                )
                if page.get("error"):
                    scrape_errors.append(f"{result.url}: {page['error']}")

        # Keep snippets even when only a subset of URLs could be scraped.
        seen_urls = {chunk["url"] for chunk in raw_chunks}
        for result in results:
            if result.url in seen_urls:
                continue
            if result.snippet and len(result.snippet.split()) >= 8:
                raw_chunks.append(
                    {
                        "title": result.title,
                        "url": result.url,
                        "text": result.snippet,
                        "provider": result.provider,
                        "fetched": False,
                    }
                )
                seen_urls.add(result.url)

        if raw_chunks:
            try:
                await db.put_cached_query(query, vol, raw_chunks, ttl)
            except Exception as exc:  # noqa: BLE001 - cache failure must not fail retrieval
                logger.warning("failed to persist epistemic cache: %s", exc)

        latency = max(1, int((time.perf_counter() - started) * 1000))
        errors = search_errors + scrape_errors
        logger.info(
            "retrieval %r: provider=%s results=%d docs=%d %dms",
            query[:70],
            provider,
            len(results),
            len(raw_chunks),
            latency,
        )
        return RetrievalResult(
            chunks=raw_chunks,
            cached=False,
            latency_ms=latency,
            provider=provider,
            urls_attempted=urls_attempted,
            errors=errors,
            search_results=len(results),
        )

    # ── Search providers ─────────────────────────────────────────────────────

    async def _search_with_fallback(
        self, query: str
    ) -> tuple[list[SearchResult], str, list[str]]:
        errors: list[str] = []
        premium_tasks: list[tuple[str, asyncio.Task[list[SearchResult]]]] = []
        if self.tavily_key:
            premium_tasks.append(("tavily", asyncio.create_task(self._tavily(query))))
        if self.serper_key:
            premium_tasks.append(("serper", asyncio.create_task(self._serper(query))))

        if premium_tasks:
            tasks = [task for _, task in premium_tasks]
            try:
                for completed in asyncio.as_completed(tasks, timeout=3.2):
                    try:
                        results = await completed
                    except Exception as exc:  # noqa: BLE001 - provider isolation
                        errors.append(str(exc)[:240])
                        continue
                    if results:
                        for task in tasks:
                            if not task.done():
                                task.cancel()
                        return results[:MAX_SEARCH_RESULTS], premium_tasks[0][0], errors
            except asyncio.TimeoutError:
                errors.append("premium search providers timed out")
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        try:
            results = await asyncio.wait_for(self._duckduckgo(query), timeout=7.0)
            if results:
                return results[:MAX_SEARCH_RESULTS], "duckduckgo", errors
            errors.append("DuckDuckGo returned no results")
        except asyncio.TimeoutError:
            errors.append("DuckDuckGo timed out")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"DuckDuckGo: {str(exc)[:240]}")
        return [], "none", errors

    async def _tavily(self, query: str) -> list[SearchResult]:
        async with httpx.AsyncClient(timeout=4.5, follow_redirects=True) as client:
            response = await client.post(
                "https://api.tavily.com/search",
                headers={"Authorization": f"Bearer {self.tavily_key}"},
                json={
                    "api_key": self.tavily_key,
                    "query": query,
                    "max_results": MAX_SEARCH_RESULTS,
                    "search_depth": "basic",
                    "include_answer": False,
                    "include_raw_content": False,
                },
            )
            response.raise_for_status()
            payload = response.json()
        results: list[SearchResult] = []
        for item in payload.get("results", [])[:MAX_SEARCH_RESULTS]:
            url = str(item.get("url", "")).strip()
            if not url.startswith(("http://", "https://")):
                continue
            results.append(
                SearchResult(
                    title=str(item.get("title") or url)[:300],
                    url=url,
                    snippet=str(item.get("content") or "")[:3000],
                    provider="tavily",
                )
            )
        return results

    async def _serper(self, query: str) -> list[SearchResult]:
        async with httpx.AsyncClient(timeout=4.5, follow_redirects=True) as client:
            response = await client.post(
                "https://google.serper.dev/search",
                headers={"X-API-KEY": self.serper_key, "Content-Type": "application/json"},
                json={"q": query, "num": MAX_SEARCH_RESULTS},
            )
            response.raise_for_status()
            payload = response.json()
        results: list[SearchResult] = []
        for item in payload.get("organic", [])[:MAX_SEARCH_RESULTS]:
            url = str(item.get("link", "")).strip()
            if not url.startswith(("http://", "https://")):
                continue
            results.append(
                SearchResult(
                    title=str(item.get("title") or url)[:300],
                    url=url,
                    snippet=str(item.get("snippet") or "")[:3000],
                    provider="serper",
                )
            )
        return results

    async def _duckduckgo(self, query: str) -> list[SearchResult]:
        """Try the maintained package, then the static HTML endpoint."""
        package_results = await self._duckduckgo_package(query)
        if package_results:
            return package_results
        return await self._duckduckgo_html(query)

    async def _duckduckgo_package(self, query: str) -> list[SearchResult]:
        try:
            from duckduckgo_search import DDGS  # imported lazily to keep startup fast

            def _run() -> list[dict[str, Any]]:
                with DDGS(timeout=5) as ddgs:
                    return list(ddgs.text(query, max_results=MAX_SEARCH_RESULTS))

            raw = await asyncio.wait_for(asyncio.to_thread(_run), timeout=6.5)
        except asyncio.TimeoutError:
            logger.warning("duckduckgo-search package timed out")
            return []
        except Exception as exc:  # noqa: BLE001 - package scrapes a hostile surface
            logger.warning("duckduckgo-search package failed: %s", str(exc)[:200])
            return []

        results: list[SearchResult] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            url = self._unwrap_duckduckgo_url(str(item.get("href") or item.get("url") or ""))
            if not url.startswith(("http://", "https://")):
                continue
            results.append(
                SearchResult(
                    title=str(item.get("title") or url)[:300],
                    url=url,
                    snippet=str(item.get("body") or "")[:3000],
                    provider="duckduckgo",
                )
            )
        return results

    async def _duckduckgo_html(self, query: str) -> list[SearchResult]:
        try:
            async with httpx.AsyncClient(
                timeout=6.0, follow_redirects=True, headers=_BASE_HEADERS
            ) as client:
                response = await client.post(
                    "https://html.duckduckgo.com/html/",
                    data={"q": query, "kl": "us-en"},
                )
                if response.status_code != 200:
                    logger.warning("duckduckgo html returned %s", response.status_code)
                    return []
                html = response.text
        except Exception as exc:  # noqa: BLE001
            logger.warning("duckduckgo html fallback failed: %s", str(exc)[:200])
            return []

        soup = BeautifulSoup(html, "html.parser")
        results: list[SearchResult] = []
        for container in soup.select(".result"):
            link = container.select_one("a.result__a")
            if link is None:
                continue
            url = self._unwrap_duckduckgo_url(str(link.get("href") or ""))
            if not url.startswith(("http://", "https://")):
                continue
            snippet_el = container.select_one(".result__snippet")
            snippet = snippet_el.get_text(" ", strip=True) if snippet_el else ""
            results.append(
                SearchResult(
                    title=link.get_text(" ", strip=True)[:300] or url,
                    url=url,
                    snippet=snippet[:3000],
                    provider="duckduckgo_html",
                )
            )
            if len(results) >= MAX_SEARCH_RESULTS:
                break
        return results

    @staticmethod
    def _unwrap_duckduckgo_url(url: str) -> str:
        if url.startswith("//"):
            url = f"https:{url}"
        parsed = urlparse(url)
        if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
            target = parse_qs(parsed.query).get("uddg", [""])[0]
            if target:
                return unquote(target)
        return url

    # ── Page scraping ────────────────────────────────────────────────────────

    async def _scrape_results(
        self, results: list[SearchResult], query: str
    ) -> list[dict[str, Any]]:
        timeout = httpx.Timeout(self.url_timeout, connect=min(1.0, self.url_timeout))
        limits = httpx.Limits(max_connections=6, max_keepalive_connections=2)
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers=_BASE_HEADERS,
            limits=limits,
        ) as client:
            tasks = [self._fetch_page(client, result) for result in results]
            pages = await asyncio.gather(*tasks, return_exceptions=True)
        normalized: list[dict[str, Any]] = []
        for result, page in zip(results, pages):
            if isinstance(page, BaseException):
                logger.info("scrape failed for %s: %s", result.url, str(page)[:160])
                normalized.append({"error": str(page)[:160]})
            else:
                normalized.append(page)
        return normalized

    async def _fetch_page(
        self, client: httpx.AsyncClient, result: SearchResult
    ) -> dict[str, Any]:
        async with client.stream("GET", result.url) as response:
            if response.status_code in {401, 403, 429}:
                return {"error": f"HTTP {response.status_code}"}
            if response.status_code >= 400:
                return {"error": f"HTTP {response.status_code}"}
            content_type = response.headers.get("content-type", "").lower()
            if content_type and not any(
                token in content_type for token in ("text/html", "application/xhtml", "text/plain")
            ):
                return {"error": f"unsupported content-type: {content_type.split(';')[0]}"}
            buffer = bytearray()
            async for chunk in response.aiter_bytes():
                buffer.extend(chunk)
                if len(buffer) >= MAX_PAGE_BYTES:
                    break
        if not buffer:
            return {"error": "empty response body"}
        encoding = response.encoding or "utf-8"
        try:
            html = bytes(buffer).decode(encoding, errors="replace")
        except LookupError:
            html = bytes(buffer).decode("utf-8", errors="replace")
        title, text = self._clean_html(html, fallback_title=result.title)
        if not text:
            return {"error": "no readable body text"}
        return {"title": title, "text": text, "url": str(response.url), "error": None}

    @staticmethod
    def _clean_html(html: str, fallback_title: str = "") -> tuple[str, str]:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "svg", "noscript", "form", "aside"]):
            tag.decompose()

        title = fallback_title
        title_tag = soup.find("title")
        if title_tag:
            candidate = title_tag.get_text(" ", strip=True)
            if candidate:
                title = candidate[:300]

        text_blocks: list[str] = []
        seen: set[str] = set()
        for tag in soup.find_all(["p", "li", "pre", "code", "h1", "h2", "h3", "blockquote", "td"]):
            block = " ".join(tag.get_text(" ", strip=True).split())
            if len(block) < 35 or block in seen:
                continue
            seen.add(block)
            text_blocks.append(block)
            if sum(len(item) for item in text_blocks) > 60_000:
                break
        text = "\n".join(text_blocks)
        return title, text

    # ── Speculation helpers ──────────────────────────────────────────────────

    async def warm_dns(self, hosts: list[str] | None = None) -> int:
        """Resolve likely search hosts early; returns milliseconds spent."""
        targets = hosts or [
            "html.duckduckgo.com",
            "duckduckgo.com",
            "github.com",
            "developer.apple.com",
            "api.tavily.com",
        ]
        started = time.perf_counter()

        async def resolve(host: str) -> None:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(socket.getaddrinfo, host, 443, proto=socket.IPPROTO_TCP),
                    timeout=0.35,
                )
            except Exception:  # noqa: BLE001 - best-effort prefetch
                return

        await asyncio.gather(*(resolve(host) for host in targets), return_exceptions=True)
        return max(1, int((time.perf_counter() - started) * 1000))

    async def warm_query(self, query: str, volatility: Volatility | str) -> RetrievalResult:
        """Prefetch a predicted query into the same epistemic cache as chat uses."""
        return await self.search_and_scrape(query, volatility)

    @staticmethod
    def fingerprint(text: str) -> str:
        normalized = re.sub(r"\s+", " ", text).strip()
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
