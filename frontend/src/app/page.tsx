"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import AutoVerifiedBanner from "@/components/AutoVerifiedBanner";
import ChatPane from "@/components/ChatPane";
import InspectorPane from "@/components/InspectorPane";
import NudgePill from "@/components/NudgePill";
import TopMenuBar, { type ConnectionState } from "@/components/TopMenuBar";
import { streamChat, type StreamHandle } from "@/lib/stream";
import type {
  ActivityLogEntry,
  AmbientContext,
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
  StageTimings,
  StateResponse,
} from "@/types/chronos";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000").replace(/\/$/, "");

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeFocus(value: number): FocusLevel {
  return value === 4 || value === 2 || value === 1 ? value : 5;
}

function urgencyFor(promise: CaughtPromise, focus: number): number {
  return Math.round(((promise.priority * promise.time_sensitivity) / Math.max(1, focus)) * 100) / 100;
}

function nudgeFromPromise(promise: CaughtPromise, focus: number): NudgePayload {
  return {
    promise_id: promise.id,
    urgency: urgencyFor(promise, focus),
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

export default function Page() {
  const [focusLevel, setFocusLevel] = useState<FocusLevel>(5);
  const [isChangingFocus, setIsChangingFocus] = useState(false);
  const [promises, setPromises] = useState<CaughtPromise[]>([]);
  const [allEntities, setAllEntities] = useState<MemoryEntity[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [providers, setProviders] = useState<Record<string, boolean>>({});
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  const [activeApp, setActiveApp] = useState("");
  const [ambient, setAmbient] = useState<AmbientContext | null>(null);
  const [ambientSupported, setAmbientSupported] = useState(false);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const isStreamingRef = useRef(false);
  const [activityLabel, setActivityLabel] = useState("Resolving local context…");

  const [hydration, setHydration] = useState<HydrationEvent | null>(null);
  const [nodes, setNodes] = useState<DAGNodeView[]>([]);
  const [planner, setPlanner] = useState<PlannerMeta | null>(null);
  const [metrics, setMetrics] = useState<SieveMetricsEvent | null>(null);
  const [timings, setTimings] = useState<StageTimings | null>(null);
  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  const [highlightedSourceId, setHighlightedSourceId] = useState<string | null>(null);

  const [speculation, setSpeculation] = useState<SpeculationView | null>(null);
  const [nudge, setNudge] = useState<NudgePayload | null>(null);
  const [simulation, setSimulation] = useState<SimulationView | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [autoVerified, setAutoVerified] = useState<{
    note: string;
    recipient: string;
  } | null>(null);
  const [isExportingTrace, setIsExportingTrace] = useState(false);
  const [showInspector, setShowInspector] = useState(false);

  const streamRef = useRef<StreamHandle | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const speculateDebounceRef = useRef<number | null>(null);
  const speculatePollRef = useRef<number | null>(null);
  const speculateAbortRef = useRef<AbortController | null>(null);
  const speculateSequenceRef = useRef(0);
  // Tokens are buffered and flushed once per frame: streaming a long answer
  // token-by-token otherwise re-renders the whole transcript on every delta.
  const tokenBufferRef = useRef<string>("");
  const tokenFrameRef = useRef<number | null>(null);

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
      setPromises(data.caught_promises ?? []);
      setAllEntities(data.memory_entities ?? []);
      setActivityLog(data.activity_log ?? []);
      setProviders(data.providers ?? {});
      const latestNudged = (data.caught_promises ?? []).find(
        (promise) => promise.status === "NUDGED",
      );
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

  // Ambient OS context is polled slowly: it changes when the user switches
  // windows, not several times a second.
  useEffect(() => {
    let cancelled = false;
    async function readAmbient() {
      try {
        const response = await fetch(`${API_BASE}/api/ambient`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as {
          ambient: AmbientContext;
          supported: boolean;
        };
        if (cancelled) return;
        setAmbient(data.ambient);
        setAmbientSupported(Boolean(data.supported));
      } catch {
        // The sensor is optional; a failure just means no ambient context.
      }
    }
    void readAmbient();
    const interval = window.setInterval(readAmbient, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

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
      } else if (event.type === "AUTO_VERIFIED_SILENT") {
        mergePromises([event.promise]);
        setAutoVerified({
          note: event.verification_note,
          recipient: event.promise.recipient,
        });
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
      streamRef.current?.abort();
    };
  }, []);

  const activePromises = useMemo(
    () => promises.filter((promise) => promise.status !== "RESOLVED"),
    [promises],
  );
  const queuedCount = activePromises.filter((promise) => promise.status === "QUEUED_QUIET").length;
  const autoVerifiedCount = activePromises.filter(
    (promise) => promise.status === "AUTO_VERIFIED_SILENT",
  ).length;

  const speculativelyFetch = useCallback(
    async (text: string, attemptsRemaining: number) => {
      const sequence = ++speculateSequenceRef.current;
      speculateAbortRef.current?.abort();
      const controller = new AbortController();

      try {
        const response = await fetch(`${API_BASE}/api/speculate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partial_text: text,
            ...(activeApp ? { active_app: activeApp } : {}),
          }),
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
          active_app: AmbientContext | null;
        };
        if (sequence !== speculateSequenceRef.current) return;

        setSpeculation({
          status: data.status,
          matchedEntities: data.matched_entities,
          predictedQueries: data.predicted_queries,
          savedMs: data.saved_ms,
          speculativeQuery: data.speculative_query,
        });
        if (data.active_app) setAmbient(data.active_app);

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
    },
    [activeApp],
  );

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
            const release = data.released.find((item) => item.promise_id === current.promiseId);
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
        void refreshState();
      } catch (error) {
        setErrorBanner(error instanceof Error ? error.message : "Could not resolve the promise.");
        throw error;
      }
    },
    [mergePromises, refreshState],
  );

  const handleSimulate = useCallback(
    async (alreadyCompleted = false) => {
      if (isSimulating) return;
      setIsSimulating(true);
      setErrorBanner(null);
      try {
        const response = await fetch(`${API_BASE}/api/simulate-mutation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ focus_level: focusLevel, already_completed: alreadyCompleted }),
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
          autoVerified: Boolean(data.auto_verified),
          verificationNote: data.verification_note ?? null,
        });
        if (data.auto_verified) {
          setAutoVerified({
            note: data.verification_note ?? data.message,
            recipient: data.promise.recipient,
          });
        }
        if (data.nudge) {
          setNudge(data.nudge);
        } else {
          setNudge((current) =>
            current && current.promise_id === data.promise.id ? null : current,
          );
        }
        setFocusLevel(normalizeFocus(data.focus_level));
        void refreshState();
      } catch (error) {
        setErrorBanner(
          error instanceof Error ? error.message : "Simulated webpage mutation failed.",
        );
      } finally {
        setIsSimulating(false);
      }
    },
    [focusLevel, isSimulating, mergePromises, refreshState],
  );

  const handleExportTrace = useCallback(async () => {
    setIsExportingTrace(true);
    try {
      const response = await fetch(`${API_BASE}/api/trace/export`, { cache: "no-store" });
      if (!response.ok) throw new Error(await parseApiError(response));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "chronos-trace.json";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorBanner(
        error instanceof Error ? error.message : "Could not export the trace.",
      );
    } finally {
      setIsExportingTrace(false);
    }
  }, []);

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
          wave: event.wave ?? 1,
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
                wave: event.wave ?? node.wave,
              }
            : node,
        );
      });
    },
    [],
  );

  const flushTokens = useCallback(() => {
    tokenFrameRef.current = null;
    const buffered = tokenBufferRef.current;
    if (!buffered) return;
    tokenBufferRef.current = "";
    const assistantId = activeAssistantIdRef.current;
    if (!assistantId) return;
    setMessages((previous) =>
      previous.map((message) =>
        message.id === assistantId ? { ...message, content: message.content + buffered } : message,
      ),
    );
  }, []);

  const appendToAssistant = useCallback(
    (id: string, delta: string) => {
      tokenBufferRef.current += delta;
      if (tokenFrameRef.current === null) {
        tokenFrameRef.current = window.requestAnimationFrame(flushTokens);
      }
      void id;
    },
    [flushTokens],
  );

  const handleChatEvent = useCallback(
    (event: ChronosEvent, assistantId: string) => {
      switch (event.type) {
        case "HYDRATION": {
          setHydration(event);
          if (event.active_app) setAmbient(event.active_app);
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
          setActivityLabel(
            event.node.wave === 2
              ? `Wave 2 · follow-up interpolated from wave 1`
              : `Self-healing DAG · grafting ${event.node.id}`,
          );
          break;
        }
        case "SIEVE_METRICS": {
          setMetrics(event);
          setTimings(event.stage_timings_ms ?? null);
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
        case "AUTO_VERIFIED_SILENT": {
          mergePromises([event.promise]);
          setAutoVerified({
            note: event.verification_note,
            recipient: event.promise.recipient,
          });
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
        case "DONE": {
          // The sieve event carries the partial budget; the DONE event
          // carries the final one, including synthesis and the total.
          if (event.stage_timings_ms) setTimings(event.stage_timings_ms);
          break;
        }
        case "HELLO":
          break;
      }
    },
    [appendToAssistant, applyNodeUpdate, mergePromises],
  );

  const handleStop = useCallback(() => {
    streamRef.current?.abort();
    streamRef.current = null;
    if (tokenFrameRef.current !== null) {
      window.cancelAnimationFrame(tokenFrameRef.current);
      tokenFrameRef.current = null;
    }
    flushTokens();
    const assistantId = activeAssistantIdRef.current;
    if (assistantId) {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId ? { ...message, stopped: true } : message,
        ),
      );
    }
  }, [flushTokens]);

  const handleNewConversation = useCallback(() => {
    streamRef.current?.abort();
    streamRef.current = null;
    setMessages([]);
    setNodes([]);
    setMetrics(null);
    setTimings(null);
    setHydration(null);
    setPlanner(null);
    setContradictions([]);
    setHighlightedSourceId(null);
    setSimulation(null);
    setActivityLabel("");
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
      setTimings(null);
      setSimulation(null);
      setActivityLabel("Hydrating local context…");

      const userId = newId("user");
      const assistantId = newId("chronos");
      activeAssistantIdRef.current = assistantId;
      tokenBufferRef.current = "";
      setMessages((previous) => [
        ...previous,
        { id: userId, role: "user", content: text },
        { id: assistantId, role: "assistant", content: "" },
      ]);
      isStreamingRef.current = true;
      setIsStreaming(true);

      streamRef.current = streamChat({
        apiBase: API_BASE,
        message: text,
        focusLevel,
        activeApp: activeApp || undefined,
        onEvent: (event) => handleChatEvent(event, assistantId),
        onError: (message) => {
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
        },
        onDone: () => {
          flushTokens();
          isStreamingRef.current = false;
          setIsStreaming(false);
          activeAssistantIdRef.current = null;
          streamRef.current = null;
          setActivityLabel("");
        },
      });
    },
    [activeApp, focusLevel, flushTokens, handleChatEvent, input],
  );

  return (
    <div className="workspace-atmosphere relative flex h-[100dvh] min-h-0 flex-col overflow-hidden">
      <TopMenuBar
        focusLevel={focusLevel}
        onFocusChange={handleFocusChange}
        activePromises={activePromises.length}
        queuedPromises={queuedCount}
        autoVerifiedPromises={autoVerifiedCount}
        connection={connection}
        isChangingFocus={isChangingFocus}
        activeApp={activeApp}
        onActiveAppChange={setActiveApp}
        ambient={ambient}
        ambientSupported={ambientSupported}
        onToggleInspector={() => setShowInspector((current) => !current)}
        showInspector={showInspector}
        onNewConversation={handleNewConversation}
        hasMessages={messages.length > 0}
      />

      <main className="grid min-h-0 flex-1 grid-cols-12 overflow-hidden">
        <section className="relative col-span-12 flex min-h-0 min-w-0 flex-col border-r border-tint/[0.06] lg:col-span-7">
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
            activeApp={activeApp}
            ambient={ambient}
            nudgeSlot={
              nudge ? (
                <NudgePill
                  nudge={nudge}
                  onDismiss={() => setNudge(null)}
                  onResolve={handleResolve}
                />
              ) : null
            }
            autoVerifiedSlot={
              autoVerified ? (
                <AutoVerifiedBanner
                  note={autoVerified.note}
                  recipient={autoVerified.recipient}
                  onDismiss={() => setAutoVerified(null)}
                />
              ) : null
            }
          />
        </section>

        <section
          className={clsxPanel(
            "col-span-12 min-h-0 overflow-hidden lg:col-span-5 lg:block",
            showInspector ? "fixed inset-y-12 right-0 z-40 w-[min(92vw,460px)] shadow-2xl" : "hidden",
          )}
        >
          <div className="flex h-9 shrink-0 items-center justify-end border-b border-tint/[0.045] px-3 lg:hidden">
            <button
              type="button"
              onClick={() => setShowInspector(false)}
              className="flex items-center gap-1.5 rounded-[8px] border border-tint/[0.07] bg-tint/[0.03] px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted"
            >
              <X size={11} />
              close inspector
            </button>
          </div>
          <div className="h-[calc(100%-36px)] lg:h-full">
            <InspectorPane
              hydration={hydration}
              allEntities={allEntities}
              speculation={speculation}
              nodes={nodes}
              planner={planner}
              metrics={metrics}
              timings={timings}
              promises={activePromises}
              focusLevel={focusLevel}
              highlightedSourceId={highlightedSourceId}
              onCitationHover={setHighlightedSourceId}
              onSimulate={() => void handleSimulate(false)}
              onSimulateCompleted={() => void handleSimulate(true)}
              isSimulating={isSimulating}
              simulation={simulation}
              providers={providers}
              connected={connection === "live"}
              ambient={ambient}
              activityLog={activityLog}
              onExportTrace={() => void handleExportTrace()}
              isExportingTrace={isExportingTrace}
            />
          </div>
        </section>
      </main>

      {errorBanner ? (
        <div className="absolute right-4 top-14 z-50 w-[min(92vw,430px)] animate-fade-up">
          <div className="glass-popover flex items-start gap-2.5 rounded-[11px] border-danger/20 px-3 py-2.5">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-danger/10">
              <AlertTriangle size={11} className="text-danger-fg" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-danger-fg/80">
                Engine notice
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink">{errorBanner}</p>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition-colors hover:bg-tint/[0.06] hover:text-ink"
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

/** Tiny helper so the inspector panel can toggle without pulling in clsx here. */
function clsxPanel(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}
