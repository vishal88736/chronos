"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ClipboardCopy,
  CornerDownLeft,
  Database,
  GitCompare,
  Loader2,
  Monitor,
  Radio,
  Search,
  Sparkles,
  Square,
  Zap,
} from "lucide-react";
import type {
  AmbientContext,
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
  activeApp?: string;
  ambient?: AmbientContext | null;
  nudgeSlot?: React.ReactNode;
  autoVerifiedSlot?: React.ReactNode;
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
  {
    prompt:
      "Search obscure legacy WebRTC bug (trigger heal) and check workarounds for my stack.",
    eyebrow: "HEALING BRANCH",
    icon: Zap,
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
      title={
        source
          ? `${source.title} · ${source.domain || "unknown host"} · composite ${source.composite_score.toFixed(2)}`
          : sourceId
      }
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
    <div className="chat-copy text-[13.5px] leading-[1.78] tracking-[-0.006em] text-ink">
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

function CopyAnswerButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="flex items-center gap-1 rounded-[6px] border border-tint/[0.06] bg-tint/[0.02] px-1.5 py-[3px] font-mono text-[10px] uppercase tracking-[0.09em] text-faint transition-colors hover:border-accent/25 hover:text-accent-fg"
      title="Copy this answer to the clipboard"
    >
      {copied ? <Check size={9} className="text-accent-fg" /> : <ClipboardCopy size={9} />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

function AssistantActivity({ label }: { label: string }) {
  return (
    <div className="animate-fade-in space-y-3 py-0.5" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-[12.5px] font-medium tracking-[-0.005em] text-accent-fg/85">
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
            <AlertTriangle size={12} className="text-danger-fg" />
            <span className="font-mono text-[11px] uppercase tracking-[0.13em] text-danger-fg/90">
              Source discrepancy detected
            </span>
            <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
              {item.source_a} ↔ {item.source_b}
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] font-medium text-danger-fg/90">{item.topic}</p>
          {item.detail ? (
            <p className="mt-1 text-[12.5px] leading-relaxed text-danger-fg/55">{item.detail}</p>
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
                className="rounded border border-danger/20 bg-danger/[0.07] px-1.5 py-0.5 font-mono text-[11px] text-danger-fg/85 transition-colors hover:border-danger/40 hover:bg-danger/[0.12]"
              >
                [{sourceId}]
              </button>
            ))}
            <span className="ml-auto text-[11px] text-faint">hover to inspect both chunks</span>
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
  activeApp,
  ambient,
  nudgeSlot,
  autoVerifiedSlot,
}: ChatPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [inputFocused, setInputFocused] = useState(false);

  const sources = metrics?.sources ?? [];
  const latestAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;
  const lastMessage = messages[messages.length - 1];

  // Only auto-scroll when the reader is already at the bottom. Force-scrolling
  // on every token made it impossible to read an earlier answer while the
  // next one streamed in.
  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottomRef.current = distance < 120;
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
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
  const ambientLabel =
    activeApp || (ambient?.available ? `${ambient.app || "Ambient"} ${ambient.title || ""}`.trim() : "");

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {nudgeSlot || autoVerifiedSlot ? (
        <div className="relative z-30 shrink-0 space-y-2 px-3 pb-2 pt-2.5 sm:px-4">
          {nudgeSlot}
          {autoVerifiedSlot}
        </div>
      ) : null}

      <div className="flex h-9 shrink-0 items-center justify-between border-b border-tint/[0.045] px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
            Ambient session
          </span>
          <span className="hidden h-[3px] w-[3px] rounded-full bg-tint/15 sm:block" />
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-healthy/90 shadow-[0_0_7px_rgba(16,185,129,0.55)]" : "bg-danger/80",
              )}
            />
            {connected ? "nudge stream armed" : "reconnecting"}
          </span>
        </div>
        <div className="flex items-center gap-2.5 text-[11px] text-faint">
          {ambientLabel ? (
            <span
              className="hidden max-w-[220px] items-center gap-1.5 font-mono uppercase tracking-[0.1em] sm:flex"
              title="Ambient OS context folded into the search DAG"
            >
              <Monitor size={9.5} className="text-accent-fg/70" />
              <span className="truncate">{ambientLabel}</span>
            </span>
          ) : null}
          <span className="hidden items-center gap-1.5 font-mono uppercase tracking-[0.11em] sm:flex">
            <Database size={9.5} />
            local context
          </span>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-subtle relative flex-1 overflow-y-auto overflow-x-hidden px-5 pb-14 pt-6 sm:px-7"
      >
        {showIdleState ? (
          <div className="mx-auto flex min-h-full max-w-[620px] flex-col pb-6 pt-2">
            {/* `my-auto` centres the block when there is room and simply
                scrolls it into view when there is not — `justify-center`
                clips the overflow on short viewports. */}
            <div className="my-auto animate-fade-up">
              <div className="mb-5 flex items-center gap-2.5">
                <div className="relative flex h-8 w-8 items-center justify-center rounded-[10px] border border-accent/25 bg-accent/[0.09] text-accent-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_30px_rgba(16,185,129,0.1)]">
                  <Sparkles size={14} strokeWidth={1.8} />
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full border border-canvas bg-healthy" />
                </div>
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.17em] text-accent-fg/80">
                    Zero-prompt context online
                  </p>
                  <p className="mt-0.5 text-[12px] text-faint">
                    Hydration runs before the search leaves your machine
                  </p>
                </div>
              </div>

              <h1 className="font-display max-w-[520px] text-[34px] leading-[1.1] tracking-[-0.035em] text-ink-strong sm:text-[42px]">
                Find what you need.
                <br />
                <span className="text-faint">Keep your word.</span>
              </h1>
              <p className="mt-3.5 max-w-[470px] text-[13.5px] leading-[1.75] text-muted">
                Chronos decomposes the question, hedges every source, and keeps watching the
                thing you&apos;re waiting on. Your local context never becomes a search query.
              </p>

              <div className="mt-7 flex items-center gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
                  Start with a live trace
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-tint/[0.08] to-transparent" />
              </div>

              <div className="mt-2.5 space-y-2">
                {STARTER_PROMPTS.map((starter, index) => {
                  const Icon = starter.icon;
                  return (
                    <button
                      key={starter.eyebrow}
                      type="button"
                      onClick={() => onSend(starter.prompt)}
                      className="group relative w-full overflow-hidden rounded-[14px] border border-tint/[0.07] bg-tint/[0.014] px-4 py-3 text-left transition-all duration-200 hover:border-accent/25 hover:bg-accent/[0.03]"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-tint/[0.07] bg-tint/[0.03] text-muted transition-colors group-hover:border-accent/20 group-hover:text-accent-fg">
                          <Icon size={13} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors group-hover:text-accent-fg/70">
                              {starter.eyebrow}
                            </span>
                            <span className="font-mono text-[10.5px] text-tint/15">
                              0{index + 1}
                            </span>
                          </div>
                          <p className="mt-1 text-[12.5px] leading-[1.55] text-muted transition-colors group-hover:text-ink">
                            {starter.prompt}
                          </p>
                        </div>
                        <ArrowUp
                          size={13}
                          className="ml-auto mt-1 shrink-0 -rotate-45 text-faint/50 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent-fg"
                        />
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 hidden grid-cols-3 gap-2 sm:grid">
                {[
                  { icon: Database, label: "SQLite graph", detail: "hydrated pre-flight" },
                  { icon: Search, label: "Hedged retrieval", detail: "1.8s per URL" },
                  { icon: Radio, label: "SSE telemetry", detail: "same-turn trace" },
                ].map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <div
                      key={feature.label}
                      className="rounded-[10px] border border-tint/[0.05] bg-tint/[0.012] px-2.5 py-2.5"
                    >
                      <Icon size={10.5} className="text-faint" />
                      <p className="mt-1.5 text-[11px] font-medium text-muted">{feature.label}</p>
                      <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-faint">
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
                          <Sparkles size={8.5} className="text-accent-fg" />
                        </div>
                        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent-fg/80">
                          Chronos
                        </span>
                        {isLatestAssistant && metrics && !isStreaming ? (
                          <span className="flex items-center gap-1.5 rounded-full border border-tint/[0.06] bg-tint/[0.02] px-1.5 py-[2px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">
                            <span className="h-1 w-1 rounded-full bg-cached" />
                            {metrics.sources.length} source{metrics.sources.length === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {isPendingAssistant ? (
                          <span className="animate-pulse-soft font-mono text-[10.5px] uppercase tracking-[0.12em] text-faint">
                            streaming
                          </span>
                        ) : null}
                        {isLatestAssistant && !isStreaming && message.content ? (
                          <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
                            <CopyAnswerButton content={message.content} />
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
                            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.1em] text-faint">
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
                            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-tint/[0.055] pt-2.5">
                              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-faint">
                                {metrics.raw_tokens.toLocaleString()} raw →{" "}
                                <span className="text-cached/80">
                                  {metrics.sieved_tokens.toLocaleString()}
                                </span>{" "}
                                tok
                              </span>
                              <span className="h-[3px] w-[3px] rounded-full bg-tint/15" />
                              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-faint">
                                {metrics.compression_pct.toFixed(1)}% sieved
                              </span>
                              <span className="h-[3px] w-[3px] rounded-full bg-tint/15" />
                              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-faint">
                                BM25 peak ×{metrics.peak_bm25.toFixed(2)}
                              </span>
                              <span className="h-[3px] w-[3px] rounded-full bg-tint/15" />
                              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-faint">
                                composite {metrics.peak_composite_score.toFixed(2)}
                              </span>
                              <span className="ml-auto hidden items-center gap-1 text-[11px] text-faint sm:flex">
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
                        <span className="rounded-full border border-tint/[0.07] bg-tint/[0.025] px-2 py-[3px] font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
                          You
                        </span>
                      </div>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] leading-[1.7] tracking-[-0.012em] text-ink">
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
        <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-canvas via-canvas/85 to-transparent" />
        <div className="relative mx-auto max-w-[660px]">
          <div className="flex h-[22px] items-center px-1">
            {showSpeculation ? (
              <div
                className={clsx(
                  "flex min-w-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.05em]",
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
                    <span className="text-tint/15">·</span>
                    <span className="truncate text-faint normal-case tracking-normal">
                      {speculation?.speculativeQuery}
                    </span>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[11px] text-faint">
                <CornerDownLeft size={9} />
                <span className="font-mono uppercase tracking-[0.08em]">
                  Enter to send · Shift+Enter for newline
                </span>
              </div>
            )}
          </div>

          <div
            className={clsx(
              "relative rounded-[16px] border bg-field/95 shadow-[0_16px_38px_rgba(0,0,0,0.26),inset_0_1px_0_rgba(255,255,255,0.045)] backdrop-blur-xl transition-colors duration-200",
              inputFocused
                ? "border-accent/35 input-focused"
                : "border-tint/[0.09] hover:border-tint/[0.13]",
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
                className="composer-input scrollbar-subtle min-h-[32px] max-h-[132px] flex-1 resize-none bg-transparent px-0.5 py-1.5 text-[13px] leading-[1.55] tracking-[-0.005em] text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Ask Chronos"
              />
              <button
                type="button"
                onClick={submit}
                disabled={!isStreaming && !input.trim()}
                className={clsx(
                  "mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border transition-all duration-200",
                  isStreaming
                    ? "border-healing/25 bg-healing/[0.09] text-healing hover:bg-healing/[0.15]"
                    : input.trim()
                      ? "border-accent/30 bg-accent/[0.18] text-accent-fg shadow-[0_0_18px_rgba(16,185,129,0.16)] hover:bg-accent/[0.26]"
                      : "border-tint/[0.06] bg-tint/[0.025] text-faint",
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

          <div className="mt-2 flex items-center justify-between gap-3 px-1">
            <p className="flex items-center gap-1.5 text-[11px] text-faint">
              <span className="h-1 w-1 shrink-0 rounded-full bg-healthy/70" />
              <span className="truncate">Local-first context · search leaves no memory of you</span>
            </p>
            <p className="hidden shrink-0 font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint/80 sm:block">
              SSE · trace live
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
