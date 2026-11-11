"""Ambient OS context sensor.

Chronos can read what the user is looking at right now: the focused
application, the window title, the current editor selection and the clipboard.
That context is injected into the search DAG so a question can be answered
without the user typing the file name or the channel name.

The sensor is strictly best-effort and strictly local. Every probe is
individually guarded, a short timeout is applied to every subprocess, and a
host without the relevant tooling degrades to "no ambient context" instead of
raising. Nothing is ever sent anywhere: the values are folded into the
query planner and never leave the machine as part of a web search.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import shutil
from typing import Any

from schemas import AmbientContext

logger = logging.getLogger("chronos.ambient")

PROBE_TIMEOUT_SECONDS = 1.2
MAX_CLIPBOARD_CHARS = 600
MAX_SELECTION_CHARS = 400

# Editor / IDE applications whose window title carries the open document.
_EDITOR_HINTS = (
    "visual studio code",
    "code -",
    "cursor",
    "xcode",
    "zed",
    "sublime",
    "intellij",
    "pycharm",
    "goland",
    "android studio",
)

# Applications whose window title carries a chat channel rather than a file.
_CHAT_HINTS = ("slack", "discord", "teams", "mail", "outlook", "superhuman")

# Ordinary words that a clipboard scan must never turn into a search term.
_CLIPBOARD_NOISE = {
    "warning",
    "error",
    "function",
    "return",
    "const",
    "class",
    "import",
    "export",
    "default",
    "string",
    "number",
    "boolean",
    "undefined",
    "nullptr",
    "message",
    "warning",
    "debug",
    "traceback",
    "exception",
}


class AmbientSensor:
    """Reads the local desktop context, degrading gracefully everywhere."""

    def __init__(self) -> None:
        self.system = platform.system().lower()
        self._last: AmbientContext = AmbientContext()

    @property
    def supported(self) -> bool:
        """True when the host exposes *some* ambient surface."""
        if self.system == "darwin":
            return shutil.which("osascript") is not None
        if self.system == "linux":
            return bool(
                shutil.which("xdotool")
                or shutil.which("xprop")
                or shutil.which("wl-paste")
                or shutil.which("xclip")
                or shutil.which("xsel")
            )
        return False

    async def detect(self, override_app: str | None = None) -> AmbientContext:
        """Collect the current ambient context.

        `override_app` is the evaluator-facing switcher value: when the user
        picks an app explicitly in the UI it wins over the OS probe.
        """
        if override_app and override_app.strip():
            context = AmbientContext(
                app=override_app.strip()[:200],
                title=override_app.strip()[:200],
                source="manual",
                available=True,
            )
            context.clipboard = await self.read_clipboard()
            self._last = context
            return context

        try:
            if self.system == "darwin":
                context = await self._detect_macos()
            elif self.system == "linux":
                context = await self._detect_linux()
            else:
                context = AmbientContext()
        except Exception as exc:  # noqa: BLE001 - the sensor must never break a turn
            logger.debug("ambient detection failed: %s", exc)
            context = AmbientContext()

        context.clipboard = await self.read_clipboard()
        context.available = bool(context.app or context.title or context.clipboard)
        self._last = context
        return context

    @property
    def last(self) -> AmbientContext:
        return self._last

    # ── Platform probes ──────────────────────────────────────────────────────

    async def _detect_macos(self) -> AmbientContext:
        frontmost = await self._run(["osascript", "-e", 'tell application "System Events" to get name of first application process whose frontmost is true'])
        app = _clean_app_name(frontmost)

        title = ""
        if app:
            title = await self._run(
                [
                    "osascript",
                    "-e",
                    'tell application "System Events" to tell (first application process whose frontmost is true) to get name of every window',
                ]
            )
        title = _first_line(title)

        selection = ""
        if app and any(hint in app.lower() for hint in _EDITOR_HINTS):
            selection = await self._run(
                [
                    "osascript",
                    "-e",
                    'tell application "System Events" to tell (first application process whose frontmost is true) to get value of attribute "AXSelectedText" of focused UI element',
                ]
            )
            selection = selection[:MAX_SELECTION_CHARS]
            if not selection:
                # VS Code exposes the open document through its own title bar.
                document = await self._run(
                    [
                        "osascript",
                        "-e",
                        'tell application "System Events" to tell (first application process whose frontmost is true) to get value of attribute "AXTitle" of window 1',
                    ]
                )
                selection = _first_line(document)[:MAX_SELECTION_CHARS]

        return AmbientContext(
            app=app,
            title=title[:300],
            selection=selection,
            source="macos",
        )

    async def _detect_linux(self) -> AmbientContext:
        title = ""
        app = ""
        if shutil.which("xdotool"):
            title = await self._run(["xdotool", "getactivewindow", "getwindowname"])
            title = _first_line(title)
        elif shutil.which("xprop"):
            raw = await self._run(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
            match = re.search(r"0x[0-9a-fA-F]+", raw)
            if match:
                window_id = match.group(0)
                title = await self._run(["xprop", "-id", window_id, "WM_NAME"])
                title = _first_line(re.sub(r"WM_NAME\(STRING\) = ", "", title))

        app = _app_from_title(title)
        selection = ""
        if shutil.which("xdotool"):
            selection = await self._run(["xdotool", "getactivewindow", "getwindowname"])
            selection = selection[:MAX_SELECTION_CHARS]
        return AmbientContext(app=app, title=title[:300], selection=selection, source="linux")

    # ── Clipboard ────────────────────────────────────────────────────────────

    async def read_clipboard(self) -> str:
        """Best-effort clipboard read. Empty string when unavailable."""
        if self.system == "darwin":
            text = await self._run(["pbpaste"])
        elif shutil.which("wl-paste"):
            text = await self._run(["wl-paste", "--no-newline"])
        elif shutil.which("xclip"):
            text = await self._run(["xclip", "-selection", "clipboard", "-o"])
        elif shutil.which("xsel"):
            text = await self._run(["xsel", "--clipboard", "--output"])
        else:
            return ""
        text = text.strip()
        if not text:
            return ""
        if not _looks_like_text(text):
            logger.debug("clipboard holds binary data; ignoring it")
            return ""
        # Clipboards routinely hold megabytes of noise. Keep only a bounded
        # head so a stray file dump cannot bloat the planner prompt.
        return text[:MAX_CLIPBOARD_CHARS]

    # ── Subprocess helper ────────────────────────────────────────────────────

    async def _run(self, command: list[str]) -> str:
        if not command or shutil.which(command[0]) is None:
            return ""
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except (OSError, ValueError):
            return ""
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=PROBE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            return ""
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - probes are advisory
            return ""
        return stdout.decode("utf-8", errors="replace").strip() if stdout else ""


def _clean_app_name(raw: str) -> str:
    if not raw:
        return ""
    first = _first_line(raw)
    # System Events sometimes returns a comma separated list.
    first = first.split(",")[0].strip()
    return first[:120]


def _looks_like_text(text: str) -> bool:
    """Reject binary clipboard payloads (images, archives, PDFs)."""
    if not text:
        return False
    sample = text[:2000]
    printable = sum(
        1 for char in sample if char.isprintable() or char in "\n\r\t"
    )
    if printable / max(1, len(sample)) < 0.92:
        return False
    # A blob of text with no whitespace at all is almost never prose.
    if len(sample) > 40 and " " not in sample and "\n" not in sample:
        return False
    # PNG/ELF/JPEG magic bytes survive decoding as mojibake.
    if sample[:4] in {"\x89PNG", "\x7fELF", "PK\x03\x04", "Rar!"}:
        return False
    return True


def _first_line(raw: str) -> str:
    if not raw:
        return ""
    for line in raw.splitlines():
        cleaned = line.strip()
        if cleaned:
            return cleaned
    return ""


def _app_from_title(title: str) -> str:
    if not title:
        return ""
    lowered = title.lower()
    for hint in _CHAT_HINTS + _EDITOR_HINTS:
        if hint in lowered:
            return hint.split(" ")[0].title()
    return ""


# ── Context folding ──────────────────────────────────────────────────────────


_FILE_EXTENSIONS = (
    ".swift", ".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".java", ".kt",
    ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".m", ".mm", ".json", ".yaml",
    ".yml", ".toml", ".md", ".sh", ".sql", ".css", ".html",
)


def extract_terms(context: AmbientContext) -> list[str]:
    """Distinctive terms worth folding into a follow-up query.

    Only high-signal tokens survive: the open file's name, the channel the
    user is reading, and any identifier in the current selection. Everything
    else is noise that would pollute the web query.
    """
    terms: list[str] = []
    seen: set[str] = set()

    def _push(value: str) -> None:
        cleaned = " ".join(str(value).split()).strip(" -—:·|[]()")
        if not cleaned:
            return
        key = cleaned.lower()
        if key in seen:
            return
        seen.add(key)
        terms.append(cleaned)

    title = context.title or ""
    for match in re.findall(r"[\w./-]+\.[A-Za-z0-9]{1,6}", title):
        if match.lower().endswith(_FILE_EXTENSIONS):
            _push(os.path.basename(match))

    if context.app:
        for hint in _CHAT_HINTS:
            if hint in context.app.lower():
                _push(hint.title())

    channel = re.search(r"(#[\w-]{2,40})", f"{context.app} {title} {context.selection}")
    if channel:
        _push(channel.group(1))

    selection = context.selection or ""
    for match in re.findall(r"\b[A-Z][A-Za-z0-9_]{3,40}\b", selection)[:6]:
        _push(match)

    # Clipboard text is the weakest signal, so it only contributes long,
    # distinctive identifiers — never ordinary prose words.
    clipboard = context.clipboard or ""
    if len(clipboard) >= 24:
        for match in re.findall(r"\b[a-zA-Z_][a-zA-Z0-9_]{6,40}\b", clipboard)[:4]:
            lowered = match.lower()
            if lowered in _CLIPBOARD_NOISE:
                continue
            if not any(char.isupper() for char in match) and "_" not in match:
                continue
            _push(match)

    return terms[:8]


def fold_into_query(query: str, terms: list[str]) -> str:
    """Append ambient terms to a query, keeping it search-engine friendly."""
    if not terms:
        return query
    existing = query.lower()
    additions = [term for term in terms if term.lower() not in existing][:3]
    if not additions:
        return query
    return f"{query} {' '.join(additions)}".strip()[:600]


def describe(context: AmbientContext) -> str:
    """One-line human summary of the ambient context."""
    if not context.available:
        return "no ambient context"
    parts: list[str] = []
    if context.app:
        parts.append(context.app)
    if context.title and context.title != context.app:
        parts.append(context.title)
    if context.selection:
        parts.append(f"“{context.selection[:60]}”")
    return " · ".join(parts) if parts else "no ambient context"


sensor = AmbientSensor()
