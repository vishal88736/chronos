"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  ExternalLink,
  Flame,
  GitBranch,
  Loader2,
  Lock,
  Radar,
  Search,
  Sparkles,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  CaughtPromise,
  DAGNodeView,
  FocusLevel,
  HydrationEvent,
  MemoryEntity,
  NodeStatus,
  PlannerMeta,
  SieveMetricsEvent,
  SimulationView,
  SpeculationView,
} from "@/types/chronos";

interface InspectorPaneProps {
  hydration: HydrationEvent | null;
  allEntities: MemoryEntity[];
  speculation: SpeculationView | null;
  nodes: DAGNodeView[];
  planner: PlannerMeta | null;
  metrics: SieveMetricsEvent | null;
  promises: CaughtPromise[];
  focusLevel: FocusLevel;
  highlightedSourceId: string | null;
  onCitationHover: (sourceId: string | null) => void;
  onSimulate: () => void;
  isSimulating: boolean;
  simulation: SimulationView | null;
  providers: Record<string, boolean>;
  connected: boolean;
}

const STATUS_META: Record<
  NodeStatus,
  {
    label: string;
    text: string;
    bg: string;
    border: string;
    dot: string;
    icon: typeof CheckCircle2;
    pulse?: boolean;
  }
> = {
  PENDING: {
    label: "PENDING",
    text: "text-zinc-400",
    bg: "bg-white/[0.035]",
    border: "border-white/[0.08]",
    dot: "bg-zinc-500",
    icon: Clock3,
  },
  SCRAPING: {
    label: "SCRAPING",
    text: "text-indigo-200",
    bg: "bg-accent/[0.1]",
    border: "border-accent/25",
    dot: "bg-accent",
    icon: Loader2,
    pulse: true,
  },
  CACHED: {
    label: "CACHED",
    text: "text-cyan-200",
    bg: "bg-cached/[0.09]",
    border: "border-cached/22",
    dot: "bg-cached",
    icon: Database,
  },
  HEALING: {
    label: "HEALING",
    text: "text-amber-200",
    bg: "bg-healing/[0.085]",
    border: "border-healing/22",
    dot: "bg-healing",
    icon: Wrench,
    pulse: true,
  },
  DONE: {
    label: "DONE",
    text: "text-emerald-200",
    bg: "bg-healthy/[0.075]",
    border: "border-healthy/20",
    dot: "bg-healthy",
    icon: CheckCircle2,
  },
  FAILED: {
    label: "FAILED",
    text: "text-rose-200",
    bg: "bg-danger/[0.075]",
    border: "border-danger/20",
    dot: "bg-danger",
    icon: XCircle,
  },
};

const PROMISE_META: Record<
  CaughtPromise["status"],
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  WATCHING: {
    label: "WATCHING",
    text: "text-indigo-200",
    bg: "bg-accent/[0.09]",
    border: "border-accent/20",
    dot: "bg-accent",
  },
  QUEUED_QUIET: {
    label: "QUEUED_QUIET",
    text: "text-amber-200",
    bg: "bg-healing/[0.09]",
    border: "border-healing/22",
    dot: "bg-healing",
  },
  NUDGED: {
    label: "NUDGED",
    text: "text-emerald-200",
    bg: "bg-healthy/[0.085]",
    border: "border-healthy/20",
    dot: "bg-healthy",
  },
  RESOLVED: {
    label: "RESOLVED",
    text: "text-zinc-400",
    bg: "bg-white/[0.03]",
    border: "border-white/[0.07]",
    dot: "bg-zinc-500",
  },
};

const FOCUS_LABELS: Record<FocusLevel, string> = {
  5: "Deep Coding",
  4: "In Meeting",
  2: "Normal",
  1: "Idle",
};

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function shortHash(hash: string): string {
  if (!hash) return "—";
  if (hash.startsWith("unobserved:")) return `pending · ${hash.slice(11, 17)}`;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function SectionCard({
  index,
  title,
  subtitle,
  icon: Icon,
  meta,
  children,
}: {
  index: string;
  title: string;
  subtitle: string;
  icon: typeof Database;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-[12px] border border-white/[0.065] bg-[#0F1117]/85 shadow-[0_1px_0_rgba(255,255,255,0.025),0_12px_28px_rgba(0,0,0,0.12)]">
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />
      <div className="flex items-center gap-2 border-b border-white/[0.055] px-3.5 py-2.5">
        <span className="font-mono text-[8px] tabular-nums tracking-[0.05em] text-faint">
          {index}
        </span>
        <div className="flex h-5 w-5 items-center justify-center rounded-[5px] border border-white/[0.07] bg-white/[0.025] text-muted">
          <Icon size={10.5} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[11.5px] font-semibold tracking-[-0.005em] text-zinc-200">
            {title}
          </h2>
          <p className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.09em] text-faint">
            {subtitle}
          </p>
        </div>
        <div className="ml-auto">{meta}</div>
      </div>
      <div className="px-3.5 py-3">{children}</div>
    </section>
  );
}

function EmptyDAG() {
  return (
    <div className="rounded-[9px] border border-dashed border-white/[0.08] bg-white/[0.012] px-3 py-4">
      <div className="flex items-center gap-2.5 opacity-55">
        <div className="flex h-6 w-6 items-center justify-center rounded-[5px] border border-white/10 bg-white/[0.03] font-mono text-[8px] text-muted">
          q1
        </div>
        <div className="h-px w-4 bg-white/10" />
        <div className="h-1 flex-1 rounded-full bg-white/[0.06]" />
        <GitBranch size={10} className="text-faint" />
      </div>
      <div className="mt-2.5 flex items-center gap-2 opacity-35">
        <div className="ml-8 flex h-5 w-5 items-center justify-center rounded-[4px] border border-white/[0.07] bg-white/[0.02] font-mono text-[7px] text-faint">
          q2
        </div>
        <div className="h-1 w-2/5 rounded-full bg-white/[0.05]" />
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-faint">
        Awaiting a query. The planner will emit 2–4 parallel branches, then graft a retry node
        if BM25 confidence falls below 1.5.
      </p>
    </div>
  );
}

export default function InspectorPane({
  hydration,
  allEntities,
  speculation,
  nodes,
  planner,
  metrics,
  promises,
  focusLevel,
  highlightedSourceId,
  onCitationHover,
  onSimulate,
  isSimulating,
  simulation,
  providers,
  connected,
}: InspectorPaneProps) {
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  const activePromises = useMemo(
    () => promises.filter((promise) => promise.status !== "RESOLVED"),
    [promises],
  );
  const activeCount = activePromises.length;
  const queuedCount = activePromises.filter((promise) => promise.status === "QUEUED_QUIET").length;
  const displayEntities = hydration?.entities?.length ? hydration.entities : allEntities;
  const matchedKeys = new Set(hydration?.entities?.map((entity) => entity.key) ?? []);

  const guidePromise = activePromises[0];
  const guidePriority = guidePromise?.priority ?? 2;
  const guideSensitivity = guidePromise?.time_sensitivity ?? 2;
  const guideUrgency = (guidePriority * guideSensitivity) / focusLevel;
  const guideGated = guideUrgency < 2.5;

  useEffect(() => {
    if (!highlightedSourceId) return;
    setExpandedSources((previous) => {
      if (previous.has(highlightedSourceId)) return previous;
      const next = new Set(previous);
      next.add(highlightedSourceId);
      return next;
    });
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`source-card-${highlightedSourceId}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightedSourceId]);

  function toggleSource(sourceId: string) {
    setExpandedSources((previous) => {
      const next = new Set(previous);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#0B0D13]/65">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/[0.045] px-4">
        <div className="flex items-center gap-2">
          <Radar size={11} className="text-indigo-300/80" />
          <span className="font-mono text-[8.5px] uppercase tracking-[0.17em] text-zinc-400">
            Glass-box inspector
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-[7.5px] uppercase tracking-[0.1em] text-faint sm:inline">
            {providers.llm ? "synthesis · llm" : "synthesis · extractive"}
          </span>
          <span className="h-3 w-px bg-white/[0.08]" />
          <span className="flex items-center gap-1.5 font-mono text-[7.5px] uppercase tracking-[0.1em] text-muted">
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-healthy shadow-[0_0_6px_rgba(16,185,129,0.6)]" : "bg-danger",
              )}
            />
            {connected ? "live" : "offline"}
          </span>
        </div>
      </div>

      <div className="scrollbar-subtle flex-1 overflow-y-auto">
        <div className="space-y-2.5 p-3">
          <SectionCard
            index="01"
            title="Hydration & speculation"
            subtitle="local SQLite · pre-flight memory"
            icon={Database}
            meta={
              <span className="font-mono text-[9px] tabular-nums text-faint">
                {hydration ? `${hydration.latency_ms}ms` : "idle"}
              </span>
            }
          >
            <div className="space-y-1.5">
              {displayEntities.length === 0 ? (
                <p className="text-[10px] text-faint">Local context graph is still loading.</p>
              ) : (
                displayEntities.map((entity) => {
                  const matched = matchedKeys.has(entity.key);
                  return (
                    <div
                      key={entity.key}
                      className={clsx(
                        "group flex items-start gap-2 rounded-[7px] border px-2 py-1.5 transition-colors",
                        matched
                          ? "border-cached/15 bg-cached/[0.035]"
                          : "border-white/[0.05] bg-white/[0.012]",
                      )}
                    >
                      <span
                        className={clsx(
                          "mt-1 h-1 w-1 shrink-0 rounded-full",
                          matched ? "bg-cached shadow-[0_0_6px_rgba(6,182,212,0.6)]" : "bg-white/15",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={clsx(
                              "truncate font-mono text-[10px] tracking-[-0.02em]",
                              matched ? "text-cyan-200" : "text-zinc-400",
                            )}
                          >
                            {entity.key}
                          </span>
                          <span className="text-[8px] text-faint">→</span>
                          <span className="shrink-0 font-mono text-[7.5px] uppercase tracking-[0.05em] text-faint">
                            {entity.category}
                          </span>
                          {matched ? (
                            <span className="ml-auto shrink-0 rounded-full bg-cached/10 px-1.5 py-[1px] font-mono text-[6.5px] uppercase tracking-[0.08em] text-cached/90">
                              matched
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-[1.45] text-zinc-400/85">
                          {entity.value}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {hydration?.pronouns_resolved?.length ? (
              <p className="mt-2 font-mono text-[8px] uppercase tracking-[0.04em] text-cached/70">
                pronoun resolution · {hydration.pronouns_resolved.join(" / ")}
              </p>
            ) : null}

            <div className="mt-2.5 flex items-center gap-2 rounded-[7px] border border-white/[0.055] bg-black/20 px-2 py-1.5">
              <Zap
                size={10}
                className={clsx(
                  speculation?.status === "WARMED"
                    ? "text-cached"
                    : speculation?.status === "WARMING"
                      ? "text-healing"
                      : "text-faint",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[7.5px] uppercase tracking-[0.1em] text-faint">
                    speculative prefetch
                  </span>
                  <span
                    className={clsx(
                      "rounded-full px-1.5 py-[1px] font-mono text-[6.5px] uppercase tracking-[0.08em]",
                      speculation?.status === "WARMED"
                        ? "bg-cached/10 text-cached"
                        : speculation?.status === "WARMING"
                          ? "bg-healing/10 text-healing"
                          : "bg-white/[0.04] text-faint",
                    )}
                  >
                    {speculation?.status ?? "IDLE"}
                  </span>
                  {speculation?.status === "WARMED" && speculation.savedMs > 0 ? (
                    <span className="font-mono text-[7px] tabular-nums text-cached/70">
                      −{speculation.savedMs.toLocaleString()}ms
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-[9px] text-muted">
                  {speculation?.speculativeQuery ??
                    "Debounced at 400ms · DNS + cache warmed before send"}
                </p>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            index="02"
            title="Live DAG execution"
            subtitle="branch topology · hedged fetches"
            icon={GitBranch}
            meta={
              planner ? (
                <span className="rounded-full border border-white/[0.06] bg-white/[0.025] px-1.5 py-[2px] font-mono text-[8px] uppercase tracking-[0.06em] text-faint">
                  {planner.label} · {planner.planningMs}ms
                </span>
              ) : (
                <span className="font-mono text-[8px] uppercase tracking-[0.06em] text-faint">
                  standby
                </span>
              )
            }
          >
            {nodes.length === 0 ? (
              <EmptyDAG />
            ) : (
              <div className="space-y-1.5">
                {nodes.map((node, index) => {
                  const meta = STATUS_META[node.status];
                  const StatusIcon = meta.icon;
                  const isRetry = Boolean(node.retry_of);
                  return (
                    <div
                      key={node.id}
                      className={clsx("relative", isRetry && "ml-[18px]")}
                    >
                      {isRetry ? (
                        <div className="pointer-events-none absolute -left-[13px] -top-3 h-[22px] w-[13px] rounded-bl-[5px] border-b border-l border-healing/30" />
                      ) : null}
                      <div
                        className={clsx(
                          "relative overflow-hidden rounded-[8px] border bg-[#0B0D13]/75 transition-all duration-200",
                          meta.border,
                        )}
                      >
                        <div
                          className={clsx(
                            "absolute inset-y-0 left-0 w-[2px]",
                            node.status === "SCRAPING"
                              ? "bg-accent/60"
                              : node.status === "HEALING"
                                ? "bg-healing/60"
                                : node.status === "CACHED"
                                  ? "bg-cached/50"
                                  : node.status === "DONE"
                                    ? "bg-healthy/45"
                                    : node.status === "FAILED"
                                      ? "bg-danger/50"
                                      : "bg-white/10",
                          )}
                        />
                        <div className="pl-2.5 pr-2 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[9.5px] font-medium text-zinc-300">
                              {node.id}
                            </span>
                            <span
                              className={clsx(
                                "inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] font-mono text-[8px] uppercase tracking-[0.06em]",
                                meta.text,
                                meta.bg,
                                meta.border,
                              )}
                            >
                              <StatusIcon
                                size={7.5}
                                className={clsx(
                                  node.status === "SCRAPING" && "animate-spin",
                                  meta.pulse && "animate-pulse",
                                )}
                              />
                              {meta.label}
                            </span>
                            <span
                              className={clsx(
                                "rounded px-1 py-[1px] font-mono text-[7px] uppercase tracking-[0.05em]",
                                node.volatility === "VOLATILE"
                                  ? "bg-healing/[0.07] text-amber-300/60"
                                  : "bg-white/[0.035] text-faint",
                              )}
                            >
                              {node.volatility === "VOLATILE" ? "volatile" : "static"}
                            </span>
                            <span className="ml-auto flex items-center gap-1 font-mono text-[9px] tabular-nums text-faint">
                              {typeof node.latency_ms === "number" && node.latency_ms > 0 ? (
                                <span
                                  className={clsx(
                                    node.status === "CACHED" ? "text-cached/80" : "text-zinc-400",
                                  )}
                                >
                                  {node.latency_ms.toLocaleString()}ms
                                </span>
                              ) : null}
                              {node.chunks_found ? (
                                <>
                                  <span className="text-white/15">·</span>
                                  <span>{node.chunks_found} ch</span>
                                </>
                              ) : null}
                            </span>
                          </div>
                          <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-[1.5] text-zinc-400">
                            {node.query}
                          </p>
                          {node.detail ? (
                            <p
                              className={clsx(
                                "mt-1 truncate font-mono text-[8px] tracking-[-0.01em]",
                                node.status === "HEALING"
                                  ? "text-healing/65"
                                  : node.status === "FAILED"
                                    ? "text-danger/75"
                                    : "text-faint/75",
                              )}
                              title={node.detail}
                            >
                              ↳ {node.detail}
                            </p>
                          ) : null}
                          {node.depends_on.length > 0 ? (
                            <div className="mt-1 flex items-center gap-1 font-mono text-[7.5px] uppercase tracking-[0.05em] text-faint/70">
                              <GitBranch size={7} />
                              depends on {node.depends_on.join(", ")}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      {index < nodes.length - 1 && !isRetry && !nodes[index + 1]?.retry_of ? (
                        <div className="ml-[9px] h-1.5 w-px bg-white/[0.08]" />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          <SectionCard
            index="03"
            title="Context sieve"
            subtitle="BM25 rank · two-stage compression"
            icon={Search}
            meta={
              metrics ? (
                <span className="font-mono text-[8px] uppercase tracking-[0.06em] text-cached/80">
                  {metrics.sources.length} chunks
                </span>
              ) : (
                <span className="font-mono text-[8px] uppercase tracking-[0.06em] text-faint">
                  waiting
                </span>
              )
            }
          >
            {metrics ? (
              <>
                <div className="mb-2 flex items-end justify-between">
                  <div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-mono text-[20px] font-medium tracking-[-0.06em] tabular-nums text-zinc-200">
                        {metrics.compression_pct.toFixed(1)}
                        <span className="ml-px text-[10px] text-muted">%</span>
                      </span>
                      <span className="mb-1 font-mono text-[8px] uppercase tracking-[0.08em] text-faint">
                        noise stripped
                      </span>
                    </div>
                    <p className="mt-0.5 text-[9px] text-muted">
                      {metrics.raw_tokens.toLocaleString()} raw tokens →{" "}
                      <span className="text-cached">{metrics.sieved_tokens.toLocaleString()}</span>{" "}
                      sieved
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[8px] uppercase tracking-[0.08em] text-faint">
                      BM25 peak
                    </p>
                    <p className="mt-0.5 font-mono text-[14px] tabular-nums text-emerald-200/90">
                      {metrics.peak_bm25.toFixed(2)}
                    </p>
                  </div>
                </div>

                <div className="relative h-[8px] overflow-hidden rounded-full border border-white/[0.05] bg-white/[0.035]">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-500/55 via-accent/70 to-cached/80 shadow-[0_0_12px_rgba(99,102,241,0.16)] transition-all duration-700"
                    style={{
                      width: `${Math.max(
                        3,
                        Math.min(100, 100 - metrics.compression_pct),
                      )}%`,
                    }}
                  />
                  <div className="absolute inset-y-0 left-0 w-full bg-[repeating-linear-gradient(115deg,transparent,transparent_6px,rgba(255,255,255,0.02)_6px,rgba(255,255,255,0.02)_7px)]" />
                  <div className="shimmer-line absolute inset-y-0 w-1/4" />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[8px] uppercase tracking-[0.06em] text-faint/70">
                  <span>raw scraped</span>
                  <span>top {metrics.sources.length} / llm context</span>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <div className="rounded-[6px] border border-white/[0.055] bg-white/[0.015] px-2 py-1.5">
                    <p className="font-mono text-[8px] uppercase tracking-[0.07em] text-faint">
                      Deduped chunks
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] tabular-nums text-zinc-300">
                      {metrics.sources.length}{" "}
                      <span className="text-[8px] text-faint">selected</span>
                    </p>
                  </div>
                  <div className="rounded-[6px] border border-white/[0.055] bg-white/[0.015] px-2 py-1.5">
                    <p className="font-mono text-[8px] uppercase tracking-[0.07em] text-faint">
                      Context budget
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] tabular-nums text-zinc-300">
                      {metrics.sieved_tokens.toLocaleString()}{" "}
                      <span className="text-[8px] text-faint">tok</span>
                    </p>
                  </div>
                </div>

                <div className="mt-2.5 space-y-1.5">
                  {metrics.sources.length === 0 ? (
                    <p className="rounded-[7px] border border-dashed border-white/[0.07] px-2.5 py-2 text-[9.5px] leading-relaxed text-faint">
                      No usable chunks survived the sieve. The DAG emitted a self-healing branch
                      rather than inventing evidence.
                    </p>
                  ) : (
                    metrics.sources.map((source) => {
                      const expanded =
                        expandedSources.has(source.id) || highlightedSourceId === source.id;
                      const highlighted = highlightedSourceId === source.id;
                      const barWidth = Math.max(
                        4,
                        Math.min(
                          100,
                          (source.bm25_score / Math.max(metrics.peak_bm25, 0.01)) * 100,
                        ),
                      );
                      return (
                        <div
                          key={source.id}
                          id={`source-card-${source.id}`}
                          onMouseEnter={() => onCitationHover(source.id)}
                          onMouseLeave={() => onCitationHover(null)}
                          className={clsx(
                            "scroll-mt-3 overflow-hidden rounded-[7px] border bg-white/[0.012] transition-all duration-200",
                            highlighted
                              ? "source-highlight"
                              : "border-white/[0.055] hover:border-white/[0.1]",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => toggleSource(source.id)}
                            className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                            aria-expanded={expanded}
                          >
                            <span className="shrink-0 rounded border border-cached/20 bg-cached/[0.07] px-1 py-0.5 font-mono text-[8.5px] text-cached">
                              [{source.id}]
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[10px] font-medium text-zinc-300">
                                {source.title}
                              </span>
                              <span className="mt-0.5 flex items-center gap-1.5">
                                <span className="truncate font-mono text-[8px] uppercase tracking-[0.06em] text-faint">
                                  {hostname(source.url)}
                                </span>
                                <span className="shrink-0 font-mono text-[7px] tabular-nums text-cached/70">
                                  {source.bm25_score.toFixed(2)}
                                </span>
                              </span>
                            </span>
                            <ChevronDown
                              size={10}
                              className={clsx(
                                "shrink-0 text-faint transition-transform",
                                expanded && "rotate-180",
                              )}
                            />
                          </button>
                          <div className="px-2 pb-1.5">
                            <div className="h-[2px] overflow-hidden rounded-full bg-white/[0.04]">
                              <div
                                className="h-full rounded-full bg-cached/45"
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                          </div>
                          {expanded ? (
                            <div className="animate-fade-in border-t border-white/[0.05] px-2 pb-2 pt-2">
                              <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-[10px] leading-[1.55] text-muted/85 scrollbar-subtle">
                                {source.text}
                              </p>
                              <div className="mt-1.5 flex items-center justify-between">
                                <span className="font-mono text-[7.5px] uppercase tracking-[0.05em] text-faint">
                                  {source.token_count} tok · node {source.node_id}
                                </span>
                                <a
                                  href={source.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.05em] text-cached/65 transition-colors hover:text-cached"
                                >
                                  open source
                                  <ExternalLink size={7.5} />
                                </a>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-[8px] border border-dashed border-white/[0.07] px-3 py-3.5">
                <div className="flex items-center gap-2 opacity-40">
                  <div className="h-1 w-16 rounded-full bg-white/20" />
                  <span className="font-mono text-[7px] text-faint">→</span>
                  <div className="h-1 w-8 rounded-full bg-cached/30" />
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-faint">
                  Raw page text will be de-tagged, chunked at 120 words with 20-word overlap, and
                  BM25-scored against each query branch.
                </p>
              </div>
            )}
          </SectionCard>

          <SectionCard
            index="04"
            title="Promise daemon"
            subtitle="differential watcher · urgency gate"
            icon={BellRing}
            meta={
              <span className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.06em] text-faint">
                <span className="h-1 w-1 rounded-full bg-accent" />
                {activeCount} active
              </span>
            }
          >
            <button
              type="button"
              onClick={onSimulate}
              disabled={isSimulating}
              className="group relative mt-0.5 flex w-full items-center justify-center gap-2 overflow-hidden rounded-[8px] border border-healing/25 bg-gradient-to-b from-healing/[0.14] to-healing/[0.065] px-3 py-2 text-[10.5px] font-medium text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_8px_22px_rgba(245,158,11,0.06)] transition-all hover:border-healing/40 hover:from-healing/[0.2] disabled:cursor-wait disabled:opacity-70"
            >
              <span className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-white/[0.045] transition-transform duration-700 group-hover:translate-x-[420%]" />
              {isSimulating ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Flame size={12} className="text-healing" />
              )}
              {isSimulating ? "Running semantic diff…" : "Simulate target webpage update"}
              {!isSimulating ? (
                <span className="ml-0.5 rounded border border-healing/20 bg-black/15 px-1 font-mono text-[6.5px] uppercase tracking-[0.08em] text-amber-200/65">
                  demo
                </span>
              ) : null}
            </button>

            <div className="mt-2.5 rounded-[7px] border border-white/[0.05] bg-black/15 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[7.5px] uppercase tracking-[0.12em] text-faint">
                  cognitive-load guide
                </span>
                <span className="ml-auto font-mono text-[7.5px] uppercase tracking-[0.05em] text-zinc-500">
                  {FOCUS_LABELS[focusLevel]} · F{focusLevel}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[9.5px] leading-[1.65] text-muted">
                Urgency = ({guidePriority} × {guideSensitivity}) / {focusLevel} ={" "}
                <span className={guideGated ? "text-healing/90" : "text-emerald-200/90"}>
                  {guideUrgency.toFixed(2)}
                </span>{" "}
                {guideGated ? "< 2.50 → QUEUED_QUIET" : "≥ 2.50 → RELEASED"}
              </p>
              <p className="mt-1 text-[9px] leading-[1.55] text-faint">
                {guideGated
                  ? `Deep focus protects the moment. Click Idle (1) in the top bar and this nudge flushes immediately.`
                  : "At this focus level, a triggered promise is allowed to reach you immediately."}
              </p>
            </div>
            {queuedCount > 0 ? (
              <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.05em] text-healing/75">
                <AlertTriangle size={8} />
                {queuedCount} held nudge{queuedCount === 1 ? "" : "s"} waiting on focus transition
              </div>
            ) : null}

            {simulation ? (
              <div
                className={clsx(
                  "mt-2 animate-fade-up rounded-[8px] border px-2.5 py-2",
                  simulation.gated
                    ? "border-healing/20 bg-healing/[0.055]"
                    : "border-healthy/20 bg-healthy/[0.05]",
                )}
              >
                <div className="flex items-center gap-1.5">
                  {simulation.gated ? (
                    <Lock size={9} className="text-healing" />
                  ) : (
                    <BellRing size={9} className="text-healthy" />
                  )}
                  <span
                    className={clsx(
                      "font-mono text-[7px] uppercase tracking-[0.1em]",
                      simulation.gated ? "text-amber-200/90" : "text-emerald-200/90",
                    )}
                  >
                    {simulation.gated ? "QUEUED_QUIET · suppressed" : "NUDGE RELEASED"}
                  </span>
                  <span className="ml-auto font-mono text-[7px] tabular-nums text-faint">
                    urgency {simulation.urgency.toFixed(2)}
                  </span>
                </div>
                <p className="mt-1 text-[9px] leading-[1.5] text-zinc-400">{simulation.message}</p>
                {simulation.gated ? (
                  <p className="mt-1.5 flex items-center gap-1 font-mono text-[7px] uppercase tracking-[0.04em] text-healing/80">
                    <Activity size={7} />
                    switch to Idle (1) in the top bar to flush
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-3 border-t border-white/[0.055] pt-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-mono text-[7.5px] uppercase tracking-[0.11em] text-faint">caught promises</span>
                <span className="font-mono text-[7.5px] uppercase tracking-[0.06em] text-faint/80">{activeCount} monitored</span>
              </div>
            {activePromises.length === 0 ? (
              <div className="rounded-[8px] border border-dashed border-white/[0.07] px-3 py-3">
                <p className="text-[10px] leading-relaxed text-faint">
                  No promises caught yet. Include a commitment in a query, or run the simulator
                  to create the seeded Rahul demo promise.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {activePromises.map((promise) => {
                  const meta = PROMISE_META[promise.status];
                  const urgency = (promise.priority * promise.time_sensitivity) / focusLevel;
                  return (
                    <div
                      key={promise.id}
                      className="rounded-[8px] border border-white/[0.06] bg-white/[0.015] px-2.5 py-2"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[9px] text-zinc-300">
                          {promise.id}
                        </span>
                        <span
                          className={clsx(
                            "ml-auto inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] font-mono text-[7.5px] uppercase tracking-[0.05em]",
                            meta.text,
                            meta.bg,
                            meta.border,
                          )}
                        >
                          <span className={clsx("h-1 w-1 rounded-full", meta.dot)} />
                          {meta.label}
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-[1.45] text-zinc-300">
                        To <span className="text-zinc-100">{promise.recipient}</span> ·{" "}
                        {promise.promised_action}
                      </p>
                      <p className="mt-1 line-clamp-1 text-[9px] text-faint" title={promise.trigger_condition}>
                        ⤷ {promise.trigger_condition}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="truncate font-mono text-[8px] uppercase tracking-[0.04em] text-muted">
                          {hostname(promise.watch_url)}
                        </span>
                        <span className="ml-auto shrink-0 rounded bg-white/[0.035] px-1 py-[1px] font-mono text-[7.5px] tabular-nums text-faint">
                          {shortHash(promise.last_dom_hash)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 border-t border-white/[0.045] pt-1.5 font-mono text-[9px] tabular-nums text-faint">
                        <span>P{promise.priority}</span>
                        <span className="text-white/15">×</span>
                        <span>T{promise.time_sensitivity}</span>
                        <span className="text-white/15">÷</span>
                        <span>F{focusLevel}</span>
                        <span className="text-white/15">=</span>
                        <span
                          className={clsx(
                            urgency >= 2.5 ? "text-emerald-300/85" : "text-healing/85",
                          )}
                        >
                          {urgency.toFixed(2)}
                        </span>
                        {promise.draft_artifact ? (
                          <span className="ml-auto flex items-center gap-1 text-cached/65">
                            <Sparkles size={7} />
                            artifact staged
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </SectionCard>

          <div className="flex items-center justify-between px-1 pb-1 pt-0.5">
            <span className="font-mono text-[7px] uppercase tracking-[0.1em] text-faint/70">
              chronos / glass-box
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[7px] uppercase tracking-[0.08em] text-faint/70">
              <Clock3 size={7.5} />
              DOM poller armed
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
