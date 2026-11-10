"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowUp,
  CornerDownLeft,
  Database,
  GitCompare,
  Radio,
  Search,
  Sparkles,
  Square,
  Zap,
} from "lucide-react";
import type {
  ChatMessage,
  Contradiction,
  SieveMetricsEvent,
  SourceChunk,
  SpeculationView,
} from "@/types/chronos";

interface ChatPaneProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: (message?: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  messages: ChatMessage[];
  activityLabel: string;
  speculation: SpeculationView | null;
  metrics: SieveMetricsEvent | null;
  contradictions: Contradiction[];
  onCitationHover: (sourceId: string | null) => void;
  connected: boolean;
  nudgeSlot?: React.ReactNode;
}

const STARTER_PROMPTS = [
  {
    prompt:
      "Check if macOS Sequoia 15.4 fixed the ScreenCaptureKit memory leak—I promised Rahul I'd send the PR once Apple patches it.",
    eyebrow: "PROMISE + LIVE RELEASE",
    icon: Search,
  },
  {
    prompt:
      "Compare FastAPI vs Go Fiber tail latency benchmarks against our target latency—I'll update the architecture doc once v3 benchmarks drop.",
    eyebrow: "BENCHMARK + COMMITMENT",
    icon: GitCompare,
  },
];

function CitationButton({
  sourceId,
  sources,
  onHover,
}: {
  sourceId: string;
  sources: SourceChunk[];
  onHover: (sourceId: string | null) => void;
}) {
  const source = sources.find((item) => item.id === sourceId);
  return (
    <button
      type="button"
      className="citation-pill"
      aria-label={`Highlight ${sourceId}${source ? ` — ${source.title}` : ""} in the glass-box inspector`}
      title={source ? `${source.title} · BM25 ${source.bm25_score.toFixed(2)}` : sourceId}
      onMouseEnter={() => onHover(sourceId)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(sourceId)}
      onBlur={() => onHover(null)}
    >
      [{sourceId}]
    </button>
  );
}

function MessageCopy({
  content,
  sources,
  onCitationHover,
}: {
  content: string;
  sources: SourceChunk[];
  onCitationHover: (sourceId: string | null) => void;
}) {
  const parts = content.split(/(\[src_\d+\])/g);
  return (
    <div className="chat-copy text-[13px] leading-[1.78] tracking-[-0.006em] text-zinc-300">
      {parts.map((part, index) => {
        const citation = part.match(/^\[(src_\d+)\]$/);
        if (citation) {
          return (
            <CitationButton
              key={`${citation[1]}-${index}`}
              sourceId={citation[1]}
              sources={sources}
              onHover={onCitationHover}
            />
          );
        }
        return <span key={`text-${index}`}>{part}</span>;
      })}
    </div>
  );
}

function AssistantActivity({ label }: { label: string }) {
  return (
    <div className="animate-fade-in space-y-3 py-0.5" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
        </span>
        <span className="text-[11px] font-medium tracking-[-0.005em] text-indigo-200/85">
          {label}
        </span>
      </div>
      <div className="space-y-2">
        <div className="shimmer-line h-[7px] w-[72%] rounded-full" />
        <div className="shimmer-line h-[7px] w-[91%] rounded-full" />
        <div className="shimmer-line h-[7px] w-[48%] rounded-full" />
      </div>
    </div>
  );
}

function ContradictionCards({
  items,
  onCitationHover,
}: {
  items: Contradiction[];
  onCitationHover: (sourceId: string | null) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      {items.map((item, index) => (
        <div
          key={`${item.topic}-${index}`}
          className="animate-fade-up rounded-[11px] border border-danger/20 bg-danger/[0.055] px-3.5 py-3"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={12} className="text-rose-300" />
            <span className="font-mono text-[8.5px] uppercase tracking-[0.13em] text-rose-300/90">
              Source discrepancy detected
            </span>
            <span className="ml-auto font-mono text-[8.5px] uppercase tracking-[0.08em] text-faint">
              {item.source_a} ↔ {item.source_b}
            </span>
          </div>
          <p className="mt-1.5 text-[11.5px] font-medium text-rose-100/90">{item.topic}</p>
          {item.detail ? (
            <p className="mt-1 text-[11px] leading-relaxed text-rose-100/55">{item.detail}</p>
          ) : null}
          <div className="mt-2 flex items-center gap-1.5">
            {[item.source_a, item.source_b].map((sourceId) => (
              <button
                key={sourceId}
                type="button"
                onMouseEnter={() => onCitationHover(sourceId)}
                onMouseLeave={() => onCitationHover(null)}
                onFocus={() => onCitationHover(sourceId)}
                onBlur={() => onCitationHover(null)}
                className="rounded border border-danger/20 bg-danger/[0.07] px-1.5 py-0.5 font-mono text-[9px] text-rose-200/85 transition-colors hover:border-danger/40 hover:bg-danger/[0.12]"
              >
                [{sourceId}]
              </button>
            ))}
            <span className="ml-auto text-[9px] text-faint">hover to inspect both chunks</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ChatPane({
  input,
  onInputChange,
  onSend,
  onStop,
  isStreaming,
  messages,
  activityLabel,
  speculation,
  metrics,
  contradictions,
  onCitationHover,
  connected,
  nudgeSlot,
}: ChatPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [inputFocused, setInputFocused] = useState(false);

  const sources = metrics?.sources ?? [];
  const latestAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;
  const lastMessage = messages[messages.length - 1];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: isStreaming ? "auto" : "smooth" });
  }, [messages, isStreaming, contradictions]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 132)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (!isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  function submit() {
    if (isStreaming) {
      onStop();
      return;
    }
    if (!input.trim()) return;
    onSend();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const showIdleState = messages.length === 0;
  const showSpeculation = !isStreaming && speculation && speculation.status !== "IDLE";

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {nudgeSlot ? (
        <div className="relative z-30 shrink-0 px-3 pb-2 pt-2.5 sm:px-4">{nudgeSlot}</div>
      ) : null}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/[0.045] px-5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-faint">
            Ambient session
          </span>
          <span className="h-[3px] w-[3px] rounded-full bg-white/15" />
          <span className="flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-muted">
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-healthy/90 shadow-[0_0_7px_rgba(16,185,129,0.55)]" : "bg-danger/80",
              )}
            />
            {connected ? "nudge stream armed" : "reconnecting"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[9px] text-faint">
          <Database size={9.5} />
          <span className="font-mono uppercase tracking-[0.11em]">local context</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="scrollbar-subtle relative flex-1 overflow-y-auto overflow-x-hidden px-5 pb-6 pt-5 sm:px-7"
      >
        {showIdleState ? (
          <div className="mx-auto flex min-h-full max-w-[595px] flex-col justify-center pb-5 pt-6">
            <div className="animate-fade-up">
              <div className="mb-5 flex items-center gap-2.5">
                <div className="relative flex h-8 w-8 items-center justify-center rounded-[10px] border border-accent/25 bg-accent/[0.09] text-indigo-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_30px_rgba(99,102,241,0.08)]">
                  <Sparkles size={14} strokeWidth={1.8} />
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full border border-canvas bg-healthy" />
                </div>
                <div>
                  <p className="font-mono text-[8.5px] uppercase tracking-[0.17em] text-indigo-300/80">
                    Zero-prompt context online
                  </p>
                  <p className="mt-0.5 text-[10px] text-faint">
                    Hydration runs before the search leaves your machine
                  </p>
                </div>
              </div>

              <h1 className="max-w-[470px] text-[30px] font-semibold leading-[1.14] tracking-[-0.045em] text-zinc-100">
                Research the web.
                <br />
                <span className="text-zinc-500">Keep your word.</span>
              </h1>
              <p className="mt-3.5 max-w-[455px] text-[12px] leading-[1.75] text-muted">
                Chronos decomposes the question, hedges every source, and keeps watching the
                thing you&apos;re waiting on. Your local context never becomes a search query.
              </p>

              <div className="mt-7 flex items-center gap-2">
                <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-faint">
                  Start with a live trace
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-white/[0.08] to-transparent" />
              </div>

              <div className="mt-2.5 space-y-2">
                {STARTER_PROMPTS.map((starter, index) => {
                  const Icon = starter.icon;
                  return (
                    <button
                      key={starter.eyebrow}
                      type="button"
                      onClick={() => onSend(starter.prompt)}
                      className="group relative w-full overflow-hidden rounded-[12px] border border-white/[0.075] bg-white/[0.018] px-3.5 py-3 text-left transition-all duration-200 hover:border-accent/25 hover:bg-accent/[0.035]"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border border-white/[0.07] bg-white/[0.03] text-muted transition-colors group-hover:border-accent/20 group-hover:text-indigo-300">
                          <Icon size={12} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-faint transition-colors group-hover:text-indigo-300/70">
                              {starter.eyebrow}
                            </span>
                            <span className="font-mono text-[8px] text-white/15">0{index + 1}</span>
                          </div>
                          <p className="mt-1 text-[11.5px] leading-[1.55] text-zinc-400 transition-colors group-hover:text-zinc-300">
                            {starter.prompt}
                          </p>
                        </div>
                        <ArrowUp
                          size={13}
                          className="ml-auto mt-1 shrink-0 -rotate-45 text-faint/50 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-indigo-300"
                        />
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 grid grid-cols-3 gap-2">
                {[
                  { icon: Database, label: "SQLite graph", detail: "hydrated pre-flight" },
                  { icon: Search, label: "Hedged retrieval", detail: "1.8s per URL" },
                  { icon: Radio, label: "SSE telemetry", detail: "same-turn trace" },
                ].map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <div
                      key={feature.label}
                      className="rounded-[8px] border border-white/[0.05] bg-white/[0.012] px-2.5 py-2"
                    >
                      <Icon size={10.5} className="text-faint" />
                      <p className="mt-1.5 text-[9px] font-medium text-zinc-400">{feature.label}</p>
                      <p className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.04em] text-faint">
                        {feature.detail}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[660px] space-y-7">
            {messages.map((message) => {
              const isAssistant = message.role === "assistant";
              const isLatestAssistant = message.id === latestAssistantId;
              const isPendingAssistant =
                isAssistant && isStreaming && message.id === lastMessage?.id;
              return (
                <article key={message.id} className="group relative">
                  {isAssistant ? (
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <div className="relative flex h-4 w-4 items-center justify-center rounded-[5px] border border-accent/25 bg-accent/[0.1]">
                          <Sparkles size={8.5} className="text-indigo-300" />
                        </div>
                        <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-indigo-200/80">
                          Chronos
                        </span>
                        {isLatestAssistant && metrics && !isStreaming ? (
                          <span className="flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-1.5 py-[2px] font-mono text-[8px] uppercase tracking-[0.08em] text-faint">
                            <span className="h-1 w-1 rounded-full bg-cached" />
                            {metrics.sources.length} source{metrics.sources.length === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {isPendingAssistant ? (
                          <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint animate-pulse-soft">
                            streaming
                          </span>
                        ) : null}
                      </div>

                      {isPendingAssistant && !message.content ? (
                        <AssistantActivity label={activityLabel} />
                      ) : (
                        <>
                          <div className={clsx(isPendingAssistant && "typing-caret")}>
                            <MessageCopy
                              content={message.content}
                              sources={sources}
                              onCitationHover={onCitationHover}
                            />
                          </div>
                          {message.stopped ? (
                            <p className="mt-2 font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">
                              stream stopped by user
                            </p>
                          ) : null}
                          {isLatestAssistant && !isStreaming ? (
                            <ContradictionCards
                              items={contradictions}
                              onCitationHover={onCitationHover}
                            />
                          ) : null}
                          {isLatestAssistant && metrics && !isStreaming ? (
                            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-white/[0.055] pt-2.5">
                              <span className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-faint">
                                {metrics.raw_tokens.toLocaleString()} raw →{" "}
                                <span className="text-cached/80">
                                  {metrics.sieved_tokens.toLocaleString()}
                                </span>{" "}
                                tok
                              </span>
                              <span className="h-[3px] w-[3px] rounded-full bg-white/15" />
                              <span className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-faint">
                                {metrics.compression_pct.toFixed(1)}% sieved
                              </span>
                              <span className="h-[3px] w-[3px] rounded-full bg-white/15" />
                              <span className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-faint">
                                BM25 peak ×{metrics.peak_bm25.toFixed(2)}
                              </span>
                              <span className="ml-auto flex items-center gap-1 text-[9px] text-faint">
                                hover a citation to inspect
                              </span>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <div className="mt-[3px] flex w-[74px] shrink-0 items-start">
                        <span className="rounded-full border border-white/[0.07] bg-white/[0.025] px-2 py-[3px] font-mono text-[8px] uppercase tracking-[0.13em] text-muted">
                          You
                        </span>
                      </div>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13.5px] leading-[1.7] tracking-[-0.012em] text-zinc-200">
                        {message.content}
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
            <div ref={endRef} className="h-px" aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="relative shrink-0 px-5 pb-4 sm:px-7">
        <div className="pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-t from-[#090A0F] via-[#090A0F]/85 to-transparent" />
        <div className="relative mx-auto max-w-[660px]">
          <div className="flex h-[22px] items-center px-1">
            {showSpeculation ? (
              <div
                className={clsx(
                  "flex min-w-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.05em]",
                  speculation?.status === "WARMED" ? "text-cached/85" : "text-healing/85",
                )}
              >
                <Zap
                  size={9.5}
                  className={speculation?.status === "WARMING" ? "animate-pulse-soft" : ""}
                />
                <span className="shrink-0">
                  {speculation?.status === "WARMED"
                    ? `Speculative cache warmed${
                        speculation.savedMs > 0
                          ? ` · ${speculation.savedMs.toLocaleString()}ms saved`
                          : ""
                      }`
                    : "Speculative cache warming"}
                </span>
                {speculation?.speculativeQuery ? (
                  <>
                    <span className="text-white/15">·</span>
                    <span className="truncate text-faint normal-case tracking-normal">
                      {speculation?.speculativeQuery}
                    </span>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[8.5px] text-faint">
                <CornerDownLeft size={9} />
                <span className="font-mono uppercase tracking-[0.08em]">
                  Enter to send · Shift+Enter for newline
                </span>
              </div>
            )}
          </div>

          <div
            className={clsx(
              "relative rounded-[14px] border bg-[#101218]/95 shadow-[0_16px_38px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.045)] backdrop-blur-xl transition-colors duration-200",
              inputFocused
                ? "border-accent/35 input-focused"
                : "border-white/[0.09] hover:border-white/[0.13]",
            )}
          >
            <div className="flex items-end gap-2 p-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-faint">
                <Sparkles size={13.5} />
              </div>
              <textarea
                ref={textareaRef}
                value={input}
                rows={1}
                onChange={(event) => onInputChange(event.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                disabled={isStreaming}
                placeholder={
                  isStreaming
                    ? "Chronos is tracing the answer…"
                    : "Ask anything or make a commitment…"
                }
                className="scrollbar-subtle min-h-[32px] max-h-[132px] flex-1 resize-none bg-transparent px-0.5 py-1.5 text-[12.5px] leading-[1.55] tracking-[-0.005em] text-zinc-200 outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Ask Chronos"
              />
              <button
                type="button"
                onClick={submit}
                disabled={!isStreaming && !input.trim()}
                className={clsx(
                  "mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border transition-all duration-200",
                  isStreaming
                    ? "border-healing/25 bg-healing/[0.09] text-healing hover:bg-healing/[0.15]"
                    : input.trim()
                      ? "border-accent/30 bg-accent/[0.18] text-indigo-100 shadow-[0_0_18px_rgba(99,102,241,0.12)] hover:bg-accent/[0.26]"
                      : "border-white/[0.06] bg-white/[0.025] text-faint",
                )}
                aria-label={isStreaming ? "Stop response" : "Send message"}
                title={isStreaming ? "Stop stream" : "Send message"}
              >
                {isStreaming ? (
                  <Square size={10} fill="currentColor" />
                ) : (
                  <ArrowUp size={14} strokeWidth={2.2} />
                )}
              </button>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between px-1">
            <p className="flex items-center gap-1.5 text-[8.5px] text-faint">
              <span className="h-1 w-1 rounded-full bg-healthy/70" />
              Local-first context · search leaves no memory of you
            </p>
            <p className="font-mono text-[8px] uppercase tracking-[0.08em] text-faint/80">
              SSE · trace live
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
