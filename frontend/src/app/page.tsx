"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import ChatPane from "@/components/ChatPane";
import InspectorPane from "@/components/InspectorPane";
import NudgePill from "@/components/NudgePill";
import TopMenuBar, { type ConnectionState } from "@/components/TopMenuBar";
import type {
  CaughtPromise,
  ChatMessage,
  ChronosEvent,
  Contradiction,
  DAGNodeView,
  FocusLevel,
  FocusResponse,
  HydrationEvent,
  MemoryEntity,
  NudgePayload,
  PlannerMeta,
  SieveMetricsEvent,
  SimulateMutationResponse,
  SimulationView,
  SpeculationView,
  StateResponse,
} from "@/types/chronos";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000").replace(/\/$/, "");

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeFocus(value: number): FocusLevel {
  return value === 4 || value === 2 || value === 1 ? value : 5;
}

function urgencFor(promise: CaughtPromise, focus: number): number {
  return Math.round(((promise.priority * promise.time_sensitivity) / Math.max(1, focus)) * 100) / 100;
}

function nudgeFromPromise(promise: CaughtPromise, focus: number): NudgePayload {
  return {
    promise_id: promise.id,
    urgency: urgencFor(promise, focus),
    focus_level: focus,
    trigger_summary: promise.trigger_summary || promise.trigger_condition,
    draft_artifact: promise.draft_artifact,
    recipient: promise.recipient,
    promised_action: promise.promised_action,
  };
}

async function parseApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
    if (payload.detail) return JSON.stringify(payload.detail);
  } catch {
    // fall through to the status text
  }
  return `${response.status} ${response.statusText}`;
}

function parseSseBlock(block: string): ChronosEvent | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as ChronosEvent;
  } catch {
    return null;
  }
}

export default function Page() {
  const [focusLevel, setFocusLevel] = useState<FocusLevel>(5);
  const [isChangingFocus, setIsChangingFocus] = useState(false);
  const [promises, setPromises] = useState<CaughtPromise[]>([]);
  const [allEntities, setAllEntities] = useState<MemoryEntity[]>([]);
  const [providers, setProviders] = useState<Record<string, boolean>>({});
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  const [input, setInput] = useState("");
  const inputRef = useRef("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const isStreamingRef = useRef(false);
  const [activityLabel, setActivityLabel] = useState("Resolving local context…");

  const [hydration, setHydration] = useState<HydrationEvent | null>(null);
  const [nodes, setNodes] = useState<DAGNodeView[]>([]);
  const [planner, setPlanner] = useState<PlannerMeta | null>(null);
  const [metrics, setMetrics] = useState<SieveMetricsEvent | null>(null);
  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  const [highlightedSourceId, setHighlightedSourceId] = useState<string | null>(null);

  const [speculation, setSpeculation] = useState<SpeculationView | null>(null);
  const [nudge, setNudge] = useState<NudgePayload | null>(null);
  const [simulation, setSimulation] = useState<SimulationView | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const speculateDebounceRef = useRef<number | null>(null);
  const speculatePollRef = useRef<number | null>(null);
  const speculateAbortRef = useRef<AbortController | null>(null);
  const speculateSequenceRef = useRef(0);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    if (!errorBanner) return;
    const timeout = window.setTimeout(() => setErrorBanner(null), 10000);
    return () => window.clearTimeout(timeout);
  }, [errorBanner]);

  useEffect(() => {
    if (!nudge) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setNudge(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nudge]);

  const mergePromises = useCallback((incoming: CaughtPromise[]) => {
    setPromises((previous) => {
      const map = new Map(previous.map((promise) => [promise.id, promise]));
      for (const promise of incoming) {
        const current = map.get(promise.id);
        map.set(promise.id, current ? { ...current, ...promise } : promise);
      }
      return Array.from(map.values()).sort((a, b) => b.created_at - a.created_at);
    });
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/state`, { cache: "no-store" });
      if (!response.ok) throw new Error(await parseApiError(response));
      const data = (await response.json()) as StateResponse;
      setFocusLevel(normalizeFocus(data.focus_level));
      setPromises(data.caught_promises);
      setAllEntities(data.memory_entities);
      setProviders(data.providers ?? {});
      const latestNudged = data.caught_promises.find((promise) => promise.status === "NUDGED");
      if (latestNudged) {
        setNudge((current) => current ?? nudgeFromPromise(latestNudged, data.focus_level));
      }
      setConnection((current) => (current === "live" ? current : "live"));
    } catch {
      setConnection((current) => (current === "live" ? current : "offline"));
    }
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  // Nudge stream is independent of the chat request. EventSource reconnects
  // automatically if the daemon restarts while a focus session is open.
  useEffect(() => {
    const stream = new EventSource(`${API_BASE}/api/nudges/stream`);
    stream.onopen = () => setConnection("live");
    stream.onerror = () => setConnection("reconnecting");
    stream.onmessage = (message) => {
      let event: ChronosEvent | null = null;
      try {
        event = JSON.parse(message.data) as ChronosEvent;
      } catch {
        return;
      }
      if (!event) return;
      if (event.type === "NUDGE") {
        setNudge(event.nudge);
        setPromises((previous) =>
          previous.map((promise) =>
            promise.id === event.nudge.promise_id
              ? {
                  ...promise,
                  status: "NUDGED",
                  draft_artifact: event.nudge.draft_artifact ?? promise.draft_artifact,
                  trigger_summary: event.nudge.trigger_summary,
                }
              : promise,
          ),
        );
      } else if (event.type === "PROMISE_CAUGHT" || event.type === "PROMISE_UPDATED") {
        mergePromises([event.promise]);
      }
    };
    return () => stream.close();
  }, [mergePromises]);

  useEffect(() => {
    return () => {
      if (speculateDebounceRef.current) window.clearTimeout(speculateDebounceRef.current);
      if (speculatePollRef.current) window.clearTimeout(speculatePollRef.current);
      speculateAbortRef.current?.abort();
      abortRef.current?.abort();
    };
  }, []);

  const activePromises = useMemo(
    () => promises.filter((promise) => promise.status !== "RESOLVED"),
    [promises],
  );
  const queuedCount = activePromises.filter((promise) => promise.status === "QUEUED_QUIET").length;

  const speculativelyFetch = useCallback(async (text: string, attemptsRemaining: number) => {
    const sequence = ++speculateSequenceRef.current;
    speculateAbortRef.current?.abort();
    const controller = new AbortController();

    try {
      const response = await fetch(`${API_BASE}/api/speculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partial_text: text }),
        signal: controller.signal,
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        matched_entities: MemoryEntity[];
        predicted_queries: string[];
        warmed: boolean;
        saved_ms: number;
        status: "WARMED" | "WARMING" | "IDLE";
        speculative_query: string | null;
      };
      if (sequence !== speculateSequenceRef.current) return;

      setSpeculation({
        status: data.status,
        matchedEntities: data.matched_entities,
        predictedQueries: data.predicted_queries,
        savedMs: data.saved_ms,
        speculativeQuery: data.speculative_query,
      });

      if (data.status === "WARMING" && attemptsRemaining > 0) {
        if (speculatePollRef.current) window.clearTimeout(speculatePollRef.current);
        speculatePollRef.current = window.setTimeout(() => {
          if (speculateSequenceRef.current === sequence) {
            void speculativelyFetch(text, attemptsRemaining - 1);
          }
        }, 1700);
      }
    } catch (error) {
      // Speculation is ambient and must never interrupt typing.
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.warn("Chronos speculation prefetch failed", error);
      }
    }
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      if (isStreamingRef.current) return;
      if (speculateDebounceRef.current) window.clearTimeout(speculateDebounceRef.current);
      if (speculatePollRef.current) window.clearTimeout(speculatePollRef.current);
      speculateSequenceRef.current += 1;
      speculateAbortRef.current?.abort();

      if (value.trim().length < 6) {
        setSpeculation(null);
        return;
      }

      setSpeculation({
        status: "WARMING",
        matchedEntities: [],
        predictedQueries: [],
        savedMs: 0,
        speculativeQuery: null,
      });
      const text = value.trim();
      speculateDebounceRef.current = window.setTimeout(() => {
        void speculativelyFetch(text, 2);
      }, 400);
    },
    [speculativelyFetch],
  );

  const handleFocusChange = useCallback(
    async (nextFocus: FocusLevel) => {
      if (nextFocus === focusLevel || isChangingFocus) return;
      const previous = focusLevel;
      setIsChangingFocus(true);
      setFocusLevel(nextFocus);
      try {
        const response = await fetch(`${API_BASE}/api/focus`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ focus_level: nextFocus }),
        });
        if (!response.ok) throw new Error(await parseApiError(response));
        const data = (await response.json()) as FocusResponse;
        setFocusLevel(normalizeFocus(data.focus_level));
        mergePromises(data.promises);
        if (data.released.length > 0) {
          setNudge(data.released[data.released.length - 1]);
          setPromises((previousPromises) =>
            previousPromises.map((promise) =>
              data.released.some((released) => released.promise_id === promise.id)
                ? { ...promise, status: "NUDGED" }
                : promise,
            ),
          );
          const releasedIds = new Set(data.released.map((item) => item.promise_id));
          setSimulation((current) => {
            if (!current || !releasedIds.has(current.promiseId)) return current;
            const release = data.released.find(
              (item) => item.promise_id === current.promiseId,
            );
            return {
              ...current,
              gated: false,
              urgency: release?.urgency ?? current.urgency,
              focusLevel: data.focus_level,
              message: `Focus moved to level ${data.focus_level}. The held nudge cleared Urgency 2.50 and was released immediately.`,
            };
          });
        }
      } catch (error) {
        setFocusLevel(previous);
        setErrorBanner(
          error instanceof Error ? error.message : "Could not change the cognitive focus state.",
        );
      } finally {
        setIsChangingFocus(false);
      }
    },
    [focusLevel, isChangingFocus, mergePromises],
  );

  const handleResolve = useCallback(
    async (promiseId: string) => {
      try {
        const response = await fetch(`${API_BASE}/api/promises/${promiseId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) throw new Error(await parseApiError(response));
        const data = (await response.json()) as { promise: CaughtPromise };
        mergePromises([data.promise]);
        setNudge((current) => (current?.promise_id === promiseId ? null : current));
        setSimulation((current) => (current?.promiseId === promiseId ? null : current));
      } catch (error) {
        setErrorBanner(error instanceof Error ? error.message : "Could not resolve the promise.");
        throw error;
      }
    },
    [mergePromises],
  );

  const handleSimulate = useCallback(async () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setErrorBanner(null);
    try {
      const response = await fetch(`${API_BASE}/api/simulate-mutation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focus_level: focusLevel }),
      });
      if (!response.ok) throw new Error(await parseApiError(response));
      const data = (await response.json()) as SimulateMutationResponse;
      mergePromises([data.promise]);
      setSimulation({
        message: data.message,
        gated: data.gated,
        urgency: data.urgency,
        focusLevel: data.focus_level,
        promiseId: data.promise.id,
      });
      if (data.nudge) {
        setNudge(data.nudge);
      } else {
        setNudge((current) =>
          current && current.promise_id === data.promise.id ? null : current,
        );
      }
      setFocusLevel(normalizeFocus(data.focus_level));
    } catch (error) {
      setErrorBanner(
        error instanceof Error ? error.message : "Simulated webpage mutation failed.",
      );
    } finally {
      setIsSimulating(false);
    }
  }, [focusLevel, isSimulating, mergePromises]);

  const applyNodeUpdate = useCallback(
    (event: Extract<ChronosEvent, { type: "NODE_UPDATE" }>) => {
      setNodes((previous) => {
        const fallback: DAGNodeView = {
          id: event.node_id,
          query: "Auxiliary retrieval branch",
          depends_on: [],
          volatility: "VOLATILE",
          status: event.status,
          latency_ms: event.latency_ms,
          chunks_found: event.chunks_found,
          cached: event.cached,
          detail: event.detail,
        };
        const found = previous.some((node) => node.id === event.node_id);
        if (!found) return [...previous, fallback];
        return previous.map((node) =>
          node.id === event.node_id
            ? {
                ...node,
                status: event.status,
                latency_ms: event.latency_ms,
                chunks_found: event.chunks_found,
                cached: event.cached,
                detail: event.detail,
              }
            : node,
        );
      });
    },
    [],
  );

  const appendToAssistant = useCallback((id: string, delta: string) => {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === id ? { ...message, content: message.content + delta } : message,
      ),
    );
  }, []);

  const handleChatEvent = useCallback(
    (event: ChronosEvent, assistantId: string) => {
      switch (event.type) {
        case "HYDRATION": {
          setHydration(event);
          setActivityLabel(
            event.entities.length > 0
              ? `Hydrating ${event.entities.length} local ${event.entities.length === 1 ? "entity" : "entities"} · planning DAG…`
              : "Zero-prompt hydration · planning DAG…",
          );
          break;
        }
        case "DAG_PLAN": {
          setPlanner({
            label: event.planner,
            planningMs: event.planning_ms,
          });
          setNodes(
            event.nodes.map((node) => ({
              ...node,
              status: "PENDING",
            })),
          );
          setActivityLabel(
            `Executing ${event.nodes.length} branches through the hedged scraper…`,
          );
          break;
        }
        case "NODE_UPDATE": {
          applyNodeUpdate(event);
          if (event.status === "SCRAPING") {
            setActivityLabel(`Hedging sources · ${event.node_id}`);
          } else if (event.status === "CACHED") {
            setActivityLabel(`Epistemic cache hit · ${event.node_id}`);
          } else if (event.status === "HEALING") {
            setActivityLabel(`Self-healing weak evidence · ${event.node_id}`);
          } else if (event.status === "FAILED") {
            setActivityLabel(`Branch ${event.node_id} failed · preserving the trace`);
          } else {
            setActivityLabel(`Evidence landed · ${event.node_id}`);
          }
          break;
        }
        case "NODE_ADDED": {
          setNodes((previous) =>
            previous.some((node) => node.id === event.node.id)
              ? previous
              : [...previous, { ...event.node, status: "PENDING" }],
          );
          setActivityLabel(`Self-healing DAG · grafting ${event.node.id}`);
          break;
        }
        case "SIEVE_METRICS": {
          setMetrics(event);
          setActivityLabel(
            `BM25 sieve complete · streaming a grounded answer from ${event.sources.length} chunks…`,
          );
          break;
        }
        case "TOKEN": {
          appendToAssistant(assistantId, event.delta);
          break;
        }
        case "CONTRADICTIONS": {
          setContradictions(event.items);
          break;
        }
        case "PROMISE_CAUGHT": {
          mergePromises([event.promise]);
          break;
        }
        case "NUDGE": {
          setNudge(event.nudge);
          break;
        }
        case "PROMISE_UPDATED": {
          mergePromises([event.promise]);
          break;
        }
        case "ERROR": {
          setErrorBanner(event.message);
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantId && !message.content
                ? {
                    ...message,
                    content:
                      "The trace stopped before the synthesis completed. Retrieval telemetry on the right shows the last completed branches.",
                  }
                : message,
            ),
          );
          break;
        }
        case "DONE":
        case "HELLO":
          break;
      }
    },
    [appendToAssistant, applyNodeUpdate, mergePromises],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    const assistantId = activeAssistantIdRef.current;
    if (assistantId) {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId ? { ...message, stopped: true } : message,
        ),
      );
    }
  }, []);

  const handleSend = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || isStreamingRef.current) return;

      if (speculateDebounceRef.current) window.clearTimeout(speculateDebounceRef.current);
      setInput("");
      setErrorBanner(null);
      setHighlightedSourceId(null);
      setContradictions([]);
      setHydration(null);
      setNodes([]);
      setPlanner(null);
      setMetrics(null);
      setSimulation(null);
      setActivityLabel("Hydrating local context…");

      const userId = newId("user");
      const assistantId = newId("chronos");
      activeAssistantIdRef.current = assistantId;
      setMessages((previous) => [
        ...previous,
        { id: userId, role: "user", content: text },
        { id: assistantId, role: "assistant", content: "" },
      ]);
      isStreamingRef.current = true;
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let receivedDone = false;
      let receivedEngineError = false;

      try {
        const response = await fetch(`${API_BASE}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, focus_level: focusLevel }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await parseApiError(response));
        if (!response.body) throw new Error("The engine returned an empty stream.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const consume = (block: string) => {
          const event = parseSseBlock(block);
          if (!event) return;
          if (event.type === "DONE") receivedDone = true;
          if (event.type === "ERROR") receivedEngineError = true;
          handleChatEvent(event, assistantId);
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf("\n\n");
          while (separator !== -1) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            consume(block);
            separator = buffer.indexOf("\n\n");
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);

        if (!receivedDone && !receivedEngineError && !controller.signal.aborted) {
          setErrorBanner("The trace stream closed before DONE. Partial telemetry is preserved.");
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    stopped: true,
                    content:
                      message.content ||
                      "Stream stopped before the first token arrived. The DAG telemetry was preserved.",
                  }
                : message,
            ),
          );
        } else {
          const message =
            error instanceof Error ? error.message : "The Chronos engine could not be reached.";
          setErrorBanner(message);
          setMessages((previous) =>
            previous.map((item) =>
              item.id === assistantId && !item.content
                ? {
                    ...item,
                    content:
                      "I couldn't reach the Chronos engine. Check that the FastAPI backend is running and that NEXT_PUBLIC_API_BASE points to it.",
                  }
                : item,
            ),
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          isStreamingRef.current = false;
          setIsStreaming(false);
          activeAssistantIdRef.current = null;
          setActivityLabel("");
        }
      }
    },
    [focusLevel, handleChatEvent, input],
  );

  return (
    <div className="workspace-atmosphere relative flex h-[100dvh] min-h-0 flex-col overflow-hidden">
      <TopMenuBar
        focusLevel={focusLevel}
        onFocusChange={handleFocusChange}
        activePromises={activePromises.length}
        queuedPromises={queuedCount}
        connection={connection}
        isChangingFocus={isChangingFocus}
      />

      <main className="grid min-h-0 flex-1 grid-cols-12 overflow-hidden">
        <section className="relative col-span-12 flex min-h-0 min-w-0 flex-col border-r border-white/[0.07] lg:col-span-7">
          <ChatPane
            input={input}
            onInputChange={handleInputChange}
            onSend={(starter) => {
              if (starter) setInput("");
              void handleSend(starter);
            }}
            onStop={handleStop}
            isStreaming={isStreaming}
            messages={messages}
            activityLabel={activityLabel}
            speculation={speculation}
            metrics={metrics}
            contradictions={contradictions}
            onCitationHover={setHighlightedSourceId}
            connected={connection === "live"}
            nudgeSlot={
              nudge ? (
                <NudgePill
                  nudge={nudge}
                  onDismiss={() => setNudge(null)}
                  onResolve={handleResolve}
                />
              ) : null
            }
          />
        </section>

        <section className="col-span-12 hidden min-h-0 overflow-hidden lg:col-span-5 lg:block">
          <InspectorPane
            hydration={hydration}
            allEntities={allEntities}
            speculation={speculation}
            nodes={nodes}
            planner={planner}
            metrics={metrics}
            promises={activePromises}
            focusLevel={focusLevel}
            highlightedSourceId={highlightedSourceId}
            onCitationHover={setHighlightedSourceId}
            onSimulate={() => void handleSimulate()}
            isSimulating={isSimulating}
            simulation={simulation}
            providers={providers}
            connected={connection === "live"}
          />
        </section>
      </main>

      {errorBanner ? (
        <div className="absolute right-4 top-14 z-50 w-[min(92vw,430px)] animate-fade-up">
          <div className="glass-popover flex items-start gap-2.5 rounded-[11px] border-danger/20 px-3 py-2.5">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-danger/10">
              <AlertTriangle size={11} className="text-rose-300" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[8px] uppercase tracking-[0.12em] text-rose-300/80">
                Engine notice
              </p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-zinc-300">{errorBanner}</p>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
              aria-label="Dismiss error"
            >
              <X size={11} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
