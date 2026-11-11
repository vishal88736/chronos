"use client";

import { useState } from "react";
import clsx from "clsx";
import { Download, Gauge, Loader2 } from "lucide-react";
import type { StageTimings } from "@/types/chronos";

interface LatencyRibbonProps {
  timings: StageTimings | null;
  onExport: () => void;
  exporting?: boolean;
}

interface StageSlice {
  key: keyof StageTimings;
  label: string;
  value: number;
  tone: string;
}

/**
 * Stage-by-stage millisecond budget for the last turn.
 *
 * The ribbon is proportional: every bar is a share of the slowest stage, so
 * the reader can see at a glance where the time actually went.
 */
export default function LatencyRibbon({
  timings,
  onExport,
  exporting = false,
}: LatencyRibbonProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const stages: StageSlice[] = timings
    ? [
        { key: "hydration", label: "Hydration", value: timings.hydration, tone: "bg-cached" },
        { key: "dag_plan", label: "Plan", value: timings.dag_plan, tone: "bg-accent" },
        { key: "scrape", label: "Scrape", value: timings.scrape, tone: "bg-healing" },
        { key: "sieve", label: "Sieve", value: timings.sieve, tone: "bg-cached" },
        { key: "synthesis", label: "Synth", value: timings.synthesis, tone: "bg-accent" },
      ]
    : [];

  const visible = stages.filter((stage) => stage.value > 0);
  const peak = Math.max(...visible.map((stage) => stage.value), 1);
  const total = visible.reduce((sum, stage) => sum + stage.value, 0);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Gauge size={10.5} className="text-accent-fg/80" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            stage latency
          </span>
        </div>
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="flex items-center gap-1.5 rounded-[7px] border border-tint/[0.07] bg-tint/[0.025] px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.08em] text-muted transition-colors hover:border-accent/30 hover:text-accent-fg disabled:cursor-wait disabled:opacity-60"
          title="Download the flight-recorder JSON for this session"
        >
          {exporting ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
          export trace
        </button>
      </div>

      {visible.length > 0 ? (
        <>
          <div className="mt-2 flex h-[9px] w-full overflow-hidden rounded-full border border-tint/[0.05] bg-tint/[0.03]">
            {visible.map((stage) => (
              <div
                key={stage.key}
                onMouseEnter={() => setHovered(stage.key)}
                onMouseLeave={() => setHovered(null)}
                title={`${stage.label}: ${stage.value}ms`}
                className={clsx(
                  "h-full transition-all duration-500",
                  stage.tone,
                  hovered && hovered !== stage.key ? "opacity-35" : "opacity-90",
                )}
                style={{ width: `${(stage.value / total) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {visible.map((stage) => (
              <span
                key={stage.key}
                className={clsx(
                  "flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.06em] transition-opacity",
                  hovered && hovered !== stage.key ? "opacity-45" : "opacity-100",
                )}
              >
                <span className={clsx("h-1.5 w-1.5 rounded-full", stage.tone)} />
                <span className="text-faint">{stage.label}</span>
                <span className="tabular-nums text-muted">{stage.value}ms</span>
              </span>
            ))}
            <span className="ml-auto font-mono text-[9.5px] uppercase tracking-[0.06em] text-faint">
              ttft {timings?.ttft ?? 0}ms · total {timings?.total ?? 0}ms
            </span>
          </div>
        </>
      ) : (
        <p className="mt-2 rounded-[7px] border border-dashed border-tint/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-faint">
          Run a query to see the millisecond budget for each stage of the turn.
        </p>
      )}
    </div>
  );
}
