"use client";

import {
  Activity,
  Bell,
  Brain,
  CalendarClock,
  Coffee,
  Laptop,
  PauseCircle,
  Radio,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import type { FocusLevel } from "@/types/chronos";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

interface TopMenuBarProps {
  focusLevel: FocusLevel;
  onFocusChange: (level: FocusLevel) => void;
  activePromises: number;
  queuedPromises: number;
  connection: ConnectionState;
  isChangingFocus: boolean;
}

const FOCUS_OPTIONS: Array<{
  value: FocusLevel;
  label: string;
  icon: typeof Brain;
  activeClass: string;
  iconClass: string;
  dotClass: string;
}> = [
  {
    value: 5,
    label: "Deep Coding",
    icon: Brain,
    activeClass:
      "bg-accent/[0.16] text-indigo-100 ring-1 ring-inset ring-accent/30 shadow-[0_0_22px_rgba(99,102,241,0.13)]",
    iconClass: "text-indigo-300",
    dotClass: "bg-accent",
  },
  {
    value: 4,
    label: "In Meeting",
    icon: CalendarClock,
    activeClass:
      "bg-healing/[0.1] text-amber-100 ring-1 ring-inset ring-healing/25 shadow-[0_0_20px_rgba(245,158,11,0.08)]",
    iconClass: "text-amber-300",
    dotClass: "bg-healing",
  },
  {
    value: 2,
    label: "Normal",
    icon: Laptop,
    activeClass:
      "bg-healthy/[0.09] text-emerald-100 ring-1 ring-inset ring-healthy/20",
    iconClass: "text-emerald-300",
    dotClass: "bg-healthy",
  },
  {
    value: 1,
    label: "Idle",
    icon: Coffee,
    activeClass:
      "bg-cached/[0.1] text-cyan-100 ring-1 ring-inset ring-cached/25",
    iconClass: "text-cyan-300",
    dotClass: "bg-cached",
  },
];

const CONNECTION_META: Record<
  ConnectionState,
  { label: string; className: string; dotClassName: string }
> = {
  connecting: {
    label: "CONNECTING",
    className: "text-muted",
    dotClassName: "bg-muted",
  },
  live: {
    label: "LIVE",
    className: "text-emerald-300/90",
    dotClassName: "bg-healthy shadow-[0_0_8px_rgba(16,185,129,0.7)]",
  },
  reconnecting: {
    label: "RECONNECTING",
    className: "text-amber-300/90",
    dotClassName: "bg-healing",
  },
  offline: {
    label: "ENGINE OFFLINE",
    className: "text-rose-300/90",
    dotClassName: "bg-danger",
  },
};

export default function TopMenuBar({
  focusLevel,
  onFocusChange,
  activePromises,
  queuedPromises,
  connection,
  isChangingFocus,
}: TopMenuBarProps) {
  const connectionMeta = CONNECTION_META[connection];

  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center border-b border-hairline bg-[#0A0C12]/90 px-4 backdrop-blur-2xl">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="no-drag flex shrink-0 items-center gap-[7px]" aria-hidden="true">
          <span className="h-[11px] w-[11px] rounded-full border border-[#ff5f57]/35 bg-[#ff5f57] shadow-[inset_0_0_2px_rgba(0,0,0,0.35)]" />
          <span className="h-[11px] w-[11px] rounded-full border border-[#febc2e]/35 bg-[#febc2e] shadow-[inset_0_0_2px_rgba(0,0,0,0.35)]" />
          <span className="h-[11px] w-[11px] rounded-full border border-[#28c840]/35 bg-[#28c840] shadow-[inset_0_0_2px_rgba(0,0,0,0.35)]" />
        </div>

        <div className="h-4 w-px bg-white/[0.08]" aria-hidden="true" />

        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border border-white/10 bg-gradient-to-br from-[#1B1E2C] to-[#0F1118] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_8px_rgba(0,0,0,0.25)]">
            <Activity size={12} strokeWidth={2.2} className="text-indigo-300" />
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full border border-[#0A0C12] bg-healthy" />
          </div>
          <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-[12px] font-semibold tracking-[-0.015em] text-zinc-100">
              minimi
            </span>
            <span className="text-[10px] text-faint">//</span>
            <span className="hidden text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted sm:inline">
              Chronos Engine
            </span>
            <span className="sm:hidden text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted">
              Chronos
            </span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center px-3">
        <div
          className="flex items-center gap-0.5 rounded-[10px] border border-white/[0.075] bg-[#0C0E15]/90 p-[3px] shadow-[inset_0_1px_1px_rgba(0,0,0,0.35),0_1px_0_rgba(255,255,255,0.03)]"
          role="group"
          aria-label="Cognitive focus mode"
        >
          {FOCUS_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = focusLevel === option.value;
            return (
              <button
                key={option.value}
                type="button"
                title={`Switch to ${option.label} (focus level ${option.value})`}
                aria-pressed={active}
                disabled={isChangingFocus}
                onClick={() => onFocusChange(option.value)}
                className={clsx(
                  "group relative flex h-[26px] items-center gap-1.5 rounded-[7px] px-2 text-[10.5px] font-medium transition-all duration-200",
                  active
                    ? option.activeClass
                    : "text-muted hover:bg-white/[0.045] hover:text-zinc-200",
                  isChangingFocus && "cursor-wait opacity-70",
                )}
              >
                <Icon
                  size={12.5}
                  strokeWidth={active ? 2.2 : 1.8}
                  className={clsx(
                    "shrink-0 transition-colors",
                    active ? option.iconClass : "text-faint group-hover:text-muted",
                  )}
                />
                <span className="hidden lg:inline">{option.label}</span>
                <span className="font-mono text-[9px] tabular-nums tracking-tight opacity-50 lg:inline">
                  {option.value}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-1 items-center justify-end gap-2">
        <div
          className={clsx(
            "hidden items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.025] px-2.5 py-1 font-mono text-[9px] tracking-[0.08em] xl:flex",
            connectionMeta.className,
          )}
          title="Server-Sent Events connection to the promise daemon"
        >
          <Radio size={10} strokeWidth={2} />
          <span className={clsx("h-1.5 w-1.5 rounded-full", connectionMeta.dotClassName)} />
          <span>{connectionMeta.label}</span>
        </div>

        <div
          className="flex h-7 items-center gap-1.5 rounded-full border border-white/[0.075] bg-white/[0.03] px-2.5 text-[10px] text-zinc-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
          title={`${activePromises} active caught promise${activePromises === 1 ? "" : "s"}`}
        >
          <Bell size={11.5} strokeWidth={2} className="text-indigo-300" />
          <span className="font-mono text-[10px] font-medium tabular-nums text-zinc-100">
            {activePromises}
          </span>
          <span className="hidden text-[9.5px] uppercase tracking-[0.1em] text-muted xl:inline">
            Active
          </span>
        </div>

        {queuedPromises > 0 ? (
          <div
            className="flex h-7 items-center gap-1.5 rounded-full border border-healing/20 bg-healing/[0.08] px-2.5 text-[10px] text-amber-200/90"
            title={`${queuedPromises} nudge${queuedPromises === 1 ? "" : "s"} suppressed by the cognitive-load gate`}
          >
            <PauseCircle size={11.5} strokeWidth={2} className="text-healing" />
            <span className="font-mono text-[10px] tabular-nums">{queuedPromises}</span>
            <span className="hidden text-[9px] uppercase tracking-[0.08em] opacity-75 xl:inline">
              Quiet
            </span>
          </div>
        ) : null}

        <div
          className="ml-0.5 hidden h-7 w-7 items-center justify-center rounded-full border border-accent/20 bg-accent/[0.09] sm:flex"
          title="Ambient promise daemon is active"
          aria-hidden="true"
        >
          <Zap size={12} fill="currentColor" className="text-indigo-300" />
        </div>
      </div>
    </header>
  );
}
