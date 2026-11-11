"use client";

import type { ChronosEvent } from "@/types/chronos";

export interface StreamHandle {
  /** Stop the stream and release the underlying connection. */
  abort: () => void;
}

export interface StreamOptions {
  apiBase: string;
  message: string;
  focusLevel: number;
  activeApp?: string;
  onEvent: (event: ChronosEvent) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * Stream a chat turn from the Chronos engine.
 *
 * The engine exposes the same turn over `GET /api/chat/stream` so the browser
 * can use its native `EventSource` parser — no hand-rolled SSE buffer
 * splitting, no chance of a partial frame being mis-parsed. A `fetch` reader
 * is kept as a fallback for environments without `EventSource`.
 */
export function streamChat(options: StreamOptions): StreamHandle {
  const { apiBase, message, focusLevel, activeApp, onEvent, onError, onDone } = options;

  let finished = false;
  let source: EventSource | null = null;
  let controller: AbortController | null = null;

  const finish = () => {
    if (finished) return;
    finished = true;
    source?.close();
    source = null;
    controller?.abort();
    controller = null;
    onDone();
  };

  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    source?.close();
    source = null;
    controller?.abort();
    controller = null;
    onError(message);
  };

  if (typeof EventSource === "undefined") {
    void runFetchFallback();
    return { abort: () => controller?.abort() };
  }

  const params = new URLSearchParams({
    message,
    focus_level: String(focusLevel),
  });
  if (activeApp) params.set("active_app", activeApp);

  try {
    source = new EventSource(`${apiBase}/api/chat/stream?${params.toString()}`);
  } catch {
    fail("The Chronos engine could not be reached.");
    return { abort: () => undefined };
  }

  source.onopen = () => {
    // Nothing to do: the connection is healthy.
  };

  source.onmessage = (messageEvent) => {
    if (finished) return;
    let event: ChronosEvent;
    try {
      event = JSON.parse(messageEvent.data) as ChronosEvent;
    } catch {
      return;
    }
    if (event.type === "DONE") {
      onEvent(event);
      finish();
      return;
    }
    if (event.type === "ERROR") {
      onEvent(event);
      finish();
      return;
    }
    onEvent(event);
  };

  source.onerror = () => {
    if (finished) return;
    // EventSource retries automatically after a transport error. That is the
    // wrong behaviour for a one-shot turn, so the stream is closed here and
    // the caller is told the trace was interrupted.
    fail("The trace stream was interrupted before the answer completed.");
  };

  return {
    abort: () => {
      if (finished) return;
      finished = true;
      source?.close();
      source = null;
      controller?.abort();
      controller = null;
    },
  };

  async function runFetchFallback(): Promise<void> {
    controller = new AbortController();
    try {
      const response = await fetch(`${apiBase}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          focus_level: focusLevel,
          ...(activeApp ? { active_app: activeApp } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        fail(`${response.status} ${response.statusText}`);
        return;
      }
      if (!response.body) {
        fail("The engine returned an empty stream.");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          emitBlock(block);
          separator = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) emitBlock(buffer);
      if (!finished) finish();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        finish();
        return;
      }
      fail(error instanceof Error ? error.message : "The Chronos engine could not be reached.");
    }
  }

  function emitBlock(block: string): void {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;
    try {
      const event = JSON.parse(dataLines.join("\n")) as ChronosEvent;
      if (event.type === "DONE" || event.type === "ERROR") {
        onEvent(event);
        finish();
        return;
      }
      onEvent(event);
    } catch {
      // Ignore a frame that is not valid JSON.
    }
  }
}
