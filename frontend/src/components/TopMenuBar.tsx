"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  Coffee,
  Laptop,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Radio,
  ShieldCheck,
} from "lucide-react";
import clsx from "clsx";
import type { AmbientContext, FocusLevel } from "@/types/chronos";
import AmbientSwitcher from "@/components/AmbientSwitcher";
import { ChronosLockup } from "@/components/ChronosLogo";
import ThemeToggle from "@/components/ThemeToggle";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

interface TopMenuBarProps {
  focusLevel: FocusLevel;
  onFocusChange: (level: FocusLevel) => void;
  activePromises: number;
  queuedPromises: number;
  autoVerifiedPromises: number;
  connection: ConnectionState;
  isChangingFocus: boolean;
  activeApp: string;
  onActiveAppChange: (value: string) => void;
  ambient: AmbientContext | null;
  ambientSupported: boolean;
  onToggleInspector: () => void;
  showInspector: boolean;
  onNewConversation: () => void;
  hasMessages: boolean;
}

const FOCUS_OPTIONS: Array<{
  value: FocusLevel;
  label: string;
  hint: string;
  icon: typeof Brain;
  iconClass: string;
  activeClass: string;
}> = [
  {
    value: 5,
    label: "Deep coding",
    hint: "Holds every nudge below 2.50 urgency",
    icon: Brain,
    iconClass: "text-accent-fg",
    activeClass:
      "bg-accent/[0.16] text-accent-fg ring-1 ring-inset ring-accent/30 shadow-[0_0_22px_rgba(16,185,129,0.13)]",
  },
  {
    value: 4,
    label: "In meeting",
    hint: "Only urgent commitments break through",
    icon: CalendarClock,
    iconClass: "text-healing-fg",
    activeClass: "bg-healing/[0.1] text-healing-fg ring-1 ring-inset ring-healing/25",
  },
  {
    value: 2,
    label: "Normal",
    hint: "Balanced — releases at 2.50 urgency",
    icon: Laptop,
    iconClass: "text-healthy-fg",
    activeClass: "bg-healthy/[0.09] text-healthy-fg ring-1 ring-inset ring-healthy/20",
  },
  {
    value: 1,
    label: "Idle",
    hint: "Releases everything immediately",
    icon: Coffee,
    iconClass: "text-cached-fg",
    activeClass: "bg-cached/[0.1] text-cached-fg ring-1 ring-inset ring-cached/25",
  },
];

const CONNECTION_META: Record<
  ConnectionState,
  { label: string; className: string; dotClassName: string }
> = {
  connecting: { label: "CONNECTING", className: "text-muted", dotClassName: "bg-muted" },
  live: {
    label: "LIVE",
    className: "text-healthy-fg/90",
    dotClassName: "bg-healthy shadow-[0_0_8px_rgba(16,185,129,0.7)]",
  },
  reconnecting: {
    label: "RECONNECTING",
    className: "text-healing-fg/90",
    dotClassName: "bg-healing",
  },
  offline: {
    label: "OFFLINE",
    className: "text-danger-fg/90",
    dotClassName: "bg-danger",
  },
};

function FocusMenu({
  value,
  onChange,
  disabled,
}: {
  value: FocusLevel;
  onChange: (level: FocusLevel) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = FOCUS_OPTIONS.find((option) => option.value === value) ?? FOCUS_OPTIONS[0];
  const Icon = active.icon;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Cognitive focus: ${active.label}`}
        disabled={disabled}
        className={clsx(
          "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-all duration-200",
          active.activeClass,
          "border-transparent",
          disabled && "cursor-wait opacity-70",
        )}
      >
        <Icon size={12} strokeWidth={2.1} className="shrink-0" />
        <span className="hidden sm:inline">{active.label}</span>
        <span className="font-mono text-[10px] tabular-nums opacity-50">{active.value}</span>
        <ChevronDown
          size={10}
          className={clsx("shrink-0 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          className="glass-popover absolute left-1/2 top-[34px] z-50 w-[248px] -translate-x-1/2 animate-fade-up rounded-[13px] p-1.5"
        >
          <p className="px-2 pb-1 pt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">
            cognitive focus
          </p>
          {FOCUS_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={clsx(
                  "flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left transition-colors",
                  selected ? "bg-accent/[0.1]" : "hover:bg-tint/[0.045]",
                )}
              >
                <span
                  className={clsx(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border",
                    selected
                      ? "border-accent/25 bg-accent/[0.12]"
                      : "border-tint/[0.07] bg-tint/[0.025]",
                  )}
                >
                  <OptionIcon size={11.5} className={option.iconClass} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-ink">{option.label}</span>
                  <span className="block truncate text-[10.5px] text-faint">{option.hint}</span>
                </span>
                {selected ? <Check size={12} className="shrink-0 text-accent-fg" /> : null}
              </button>
            );
          })}
          <p className="mt-1 border-t border-tint/[0.06] px-2 pb-1 pt-2 font-mono text-[9.5px] leading-relaxed text-faint">
            urgency = priority × sensitivity ÷ focus
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function TopMenuBar({
  focusLevel,
  onFocusChange,
  activePromises,
  queuedPromises,
  autoVerifiedPromises,
  connection,
  isChangingFocus,
  activeApp,
  onActiveAppChange,
  ambient,
  ambientSupported,
  onToggleInspector,
  showInspector,
  onNewConversation,
  hasMessages,
}: TopMenuBarProps) {
  const connectionMeta = CONNECTION_META[connection];
  const promiseTitle = `${activePromises} active promise${activePromises === 1 ? "" : "s"} · ${queuedPromises} quiet · ${autoVerifiedPromises} auto-verified`;

  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-panel/90 px-3 backdrop-blur-2xl sm:px-4">
      <ChronosLockup />

      <div className="ml-2 hidden min-w-0 md:block">
        <AmbientSwitcher
          value={activeApp}
          onChange={onActiveAppChange}
          detectedApp={ambient?.app}
          detectedTitle={ambient?.title}
          supported={ambientSupported}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center">
        <FocusMenu value={focusLevel} onChange={onFocusChange} disabled={isChangingFocus} />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <div className="md:hidden">
          <AmbientSwitcher
            value={activeApp}
            onChange={onActiveAppChange}
            detectedApp={ambient?.app}
            detectedTitle={ambient?.title}
            supported={ambientSupported}
            align="right"
            compact
          />
        </div>

        <div
          className={clsx(
            "hidden items-center gap-1.5 rounded-full border border-tint/[0.06] bg-tint/[0.025] px-2 py-1 font-mono text-[10px] tracking-[0.08em] xl:flex",
            connectionMeta.className,
          )}
          title="Server-Sent Events connection to the promise daemon"
        >
          <Radio size={9.5} strokeWidth={2} />
          <span className={clsx("h-1.5 w-1.5 rounded-full", connectionMeta.dotClassName)} />
          <span>{connectionMeta.label}</span>
        </div>

        <div
          className="flex h-7 items-center gap-2 rounded-full border border-tint/[0.075] bg-tint/[0.03] px-2.5 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
          title={promiseTitle}
        >
          <span className="flex items-center gap-1">
            <Bell size={11} strokeWidth={2} className="text-accent-fg" />
            <span className="font-mono text-[11.5px] font-medium tabular-nums text-ink-strong">
              {activePromises}
            </span>
          </span>
          {autoVerifiedPromises > 0 ? (
            <span className="flex items-center gap-1 text-healthy-fg/90">
              <ShieldCheck size={11} strokeWidth={2} />
              <span className="font-mono text-[11px] tabular-nums">{autoVerifiedPromises}</span>
            </span>
          ) : null}
          {queuedPromises > 0 ? (
            <span
              className="h-1.5 w-1.5 rounded-full bg-healing shadow-[0_0_6px_rgba(251,191,36,0.55)]"
              aria-label={`${queuedPromises} nudge${queuedPromises === 1 ? "" : "s"} suppressed by the cognitive-load gate`}
            />
          ) : null}
        </div>

        {hasMessages ? (
          <button
            type="button"
            onClick={onNewConversation}
            title="Start a new conversation"
            aria-label="Start a new conversation"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-tint/[0.075] bg-tint/[0.03] text-muted transition-colors hover:border-accent/30 hover:text-accent-fg"
          >
            <Plus size={13} strokeWidth={2.2} />
          </button>
        ) : null}

        <ThemeToggle />

        <button
          type="button"
          onClick={onToggleInspector}
          title={showInspector ? "Hide the glass-box inspector" : "Show the glass-box inspector"}
          aria-label={showInspector ? "Hide inspector" : "Show inspector"}
          aria-pressed={showInspector}
          className={clsx(
            "flex h-7 w-7 items-center justify-center rounded-full border transition-colors",
            showInspector
              ? "border-accent/30 bg-accent/[0.1] text-accent-fg"
              : "border-tint/[0.075] bg-tint/[0.03] text-muted hover:text-ink",
          )}
        >
          {showInspector ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
        </button>
      </div>
    </header>
  );
}
