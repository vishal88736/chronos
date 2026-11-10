"""Minimal async wrapper for OpenAI-compatible chat endpoints.

Chronos treats the LLM as an accelerator, never a single point of failure. If no
key is configured (or the provider degrades), callers receive `None` / an empty
stream and switch to deterministic, retrieval-grounded behavior.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv
from openai import AsyncOpenAI

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

logger = logging.getLogger("chronos.llm")

_GROQ_BASE = "https://api.groq.com/openai/v1"
_GROQ_MODEL = "llama-3.3-70b-versatile"
_OPENAI_MODEL = "gpt-4o-mini"
_PLACEHOLDER_PREFIXES = ("your_", "changeme", "replace_")


def _clean_key(value: str | None) -> str:
    key = (value or "").strip()
    if not key or key.lower().startswith(_PLACEHOLDER_PREFIXES) or set(key) <= {"x", "*"}:
        return ""
    return key


def _extract_json(content: str) -> Any | None:
    """Accept raw JSON, fenced JSON, or prose containing a JSON object."""
    text = (content or "").strip()
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    starts = [index for index in (text.find("{"), text.find("[")) if index >= 0]
    if not starts:
        return None
    start = min(starts)
    closing = "}" if text[start] == "{" else "]"
    end = text.rfind(closing)
    if end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


class LLMClient:
    def __init__(self) -> None:
        explicit_key = _clean_key(os.getenv("LLM_API_KEY"))
        groq_key = _clean_key(os.getenv("GROQ_API_KEY"))
        openai_key = _clean_key(os.getenv("OPENAI_API_KEY"))

        self.api_key = ""
        self.base_url: str | None = None
        self.provider = "offline"
        default_model = _OPENAI_MODEL

        if explicit_key:
            self.api_key = explicit_key
            self.provider = "custom"
            explicit_base = (os.getenv("LLM_BASE_URL") or "").strip()
            if explicit_base:
                self.base_url = explicit_base.rstrip("/")
            elif explicit_key.startswith("gsk_"):
                self.base_url = _GROQ_BASE
                self.provider = "groq"
                default_model = _GROQ_MODEL
            else:
                self.base_url = "https://api.openai.com/v1"
                self.provider = "openai"
        elif groq_key:
            self.api_key = groq_key
            self.base_url = _GROQ_BASE
            self.provider = "groq"
            default_model = _GROQ_MODEL
        elif openai_key:
            self.api_key = openai_key
            self.base_url = (os.getenv("LLM_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
            self.provider = "openai"

        self.model = (os.getenv("LLM_MODEL") or default_model).strip() or default_model
        self.fast_model = (os.getenv("LLM_FAST_MODEL") or self.model).strip() or self.model
        self._client: AsyncOpenAI | None = None
        if self.api_key:
            self._client = AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                timeout=45.0,
                max_retries=0,
            )
            logger.info("LLM configured: provider=%s model=%s", self.provider, self.model)
        else:
            logger.warning(
                "No LLM key configured — Chronos will use deterministic planning and "
                "retrieval-grounded extractive synthesis."
            )

    @property
    def available(self) -> bool:
        return bool(self.api_key and self._client is not None)

    def public_info(self) -> dict[str, Any]:
        return {
            "configured": self.available,
            "provider": self.provider,
            "model": self.model if self.available else None,
            "fast_model": self.fast_model if self.available else None,
        }

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()

    async def complete_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str | None = None,
        temperature: float = 0.1,
        max_tokens: int = 1400,
        timeout: float = 35.0,
    ) -> Any | None:
        """Structured completion with one retry. Returns None on any failure."""
        if not self.available or self._client is None:
            return None

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        target_model = model or self.fast_model
        last_error: Exception | None = None

        for attempt in range(2):
            try:
                response = await self._client.chat.completions.create(
                    model=target_model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"},
                    timeout=timeout,
                )
                content = response.choices[0].message.content or ""
                parsed = _extract_json(content)
                if parsed is None:
                    raise ValueError("model returned non-JSON content")
                return parsed
            except Exception as exc:  # noqa: BLE001 - provider SDK raises broad errors
                last_error = exc
                logger.warning(
                    "LLM JSON completion failed (provider=%s attempt=%d): %s",
                    self.provider,
                    attempt + 1,
                    str(exc)[:300],
                )
                if attempt == 0:
                    await asyncio.sleep(0.35)

        logger.error("LLM JSON completion exhausted retries: %s", str(last_error)[:300])
        return None

    async def stream_text(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = 0.35,
        max_tokens: int = 1100,
        timeout: float = 60.0,
    ) -> AsyncIterator[str]:
        """Yield incremental text. Provider errors propagate to the synthesizer."""
        if not self.available or self._client is None:
            return
        stream = await self._client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
            timeout=timeout,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
