"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Check,
  ChevronDown,
  Code2,
  MessageSquare,
  Monitor,
  Terminal,
  Waypoints,
} from "lucide-react";

export interface AmbientPreset {
  id: string;
  label: string;
  detail: string;
  value: string;
  icon: typeof Code2;
}

/**
 * The evaluator-facing switcher for the ambient OS sensor.
 *
 * On macOS the backend reads the real frontmost window and clipboard. The
 * switcher exists so the same ambient path can be demonstrated on any
 * machine — and on any machine without the reader installed.
 */
export const AMBIENT_PRESETS: AmbientPreset[] = [
  {
    id: "vscode",
    label: "VS Code",
    detail: "screen_capture.swift",
    value: "VS Code — screen_capture.swift (Line 88: SCStream retain cycle)",
    icon: Code2,
  },
  {
    id: "slack",
    label: "Slack",
    detail: "#backend-eng",
    value: "Slack — #backend-eng",
    icon: MessageSquare,
  },
  {
    id: "terminal",
    label: "Terminal",
    detail: "kubectl logs",
    value: "Terminal — kubectl logs chronos-gateway",
    icon: Terminal,
  },
  {
    id: "browser",
    label: "Browser",
    detail: "apple.com",
    value: "Safari — developer.apple.com/documentation/screencapturekit",
    icon: Monitor,
  },
  {
    id: "auto",
    label: "Auto-detect",
    detail: "read the real window",
    value: "",
    icon: Waypoints,
  },
];

interface AmbientSwitcherProps {
  value: string;
  onChange: (value: string) => void;
  detectedApp?: string;
  detectedTitle?: string;
  supported?: boolean;
  /** Which edge the dropdown opens from. */
  align?: "left" | "right";
  /** Icon-only mode for tight layouts such as the mobile header. */
  compact?: boolean;
}

export default function AmbientSwitcher({
  value,
  onChange,
  detectedApp,
  detectedTitle,
  supported = false,
  align = "left",
  compact = false,
}: AmbientSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const active = AMBIENT_PRESETS.find((preset) => preset.value === value);
  const Icon = active?.icon ?? Waypoints;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={clsx(
          "group flex h-8 items-center gap-2 rounded-[10px] border px-2.5 text-left transition-all duration-200",
          compact ? "w-8 justify-center px-0" : "max-w-[260px]",
          open
            ? "border-accent/35 bg-accent/[0.09]"
            : "border-tint/[0.07] bg-tint/[0.02] hover:border-tint/[0.13] hover:bg-tint/[0.04]",
        )}
        title="Ambient OS context injected into the search DAG"
      >
        <Icon size={12.5} className="shrink-0 text-accent-fg" />
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1 leading-none">
              <span className="block truncate text-[11.5px] font-medium text-ink">
                {active?.label ?? "Ambient context"}
              </span>
              <span className="mt-[3px] block truncate font-mono text-[9.5px] uppercase tracking-[0.09em] text-faint">
                {active
                  ? active.detail
                  : detectedApp
                    ? detectedTitle?.slice(0, 34) || detectedApp
                    : supported
                      ? "auto-detect"
                      : "unavailable"}
              </span>
            </span>
            <ChevronDown
              size={11}
              className={clsx(
                "shrink-0 text-faint transition-transform duration-200",
                open && "rotate-180",
              )}
            />
          </>
        )}
      </button>

      {open ? (
        <div
          role="listbox"
          className={clsx(
            "glass-popover absolute top-[38px] z-50 w-[290px] animate-fade-up overflow-hidden rounded-[13px] p-1.5",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <p className="px-2 pb-1.5 pt-1 font-mono text-[9.5px] uppercase tracking-[0.13em] text-faint">
            ambient os context
          </p>
          {AMBIENT_PRESETS.map((preset) => {
            const PresetIcon = preset.icon;
            const selected = preset.value === value;
            return (
              <button
                key={preset.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(preset.value);
                  setOpen(false);
                }}
                className={clsx(
                  "flex w-full items-center gap-2.5 rounded-[9px] px-2 py-2 text-left transition-colors",
                  selected ? "bg-accent/[0.12]" : "hover:bg-tint/[0.045]",
                )}
              >
                <span
                  className={clsx(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border",
                    selected
                      ? "border-accent/25 bg-accent/[0.12] text-accent-fg"
                      : "border-tint/[0.07] bg-tint/[0.025] text-muted",
                  )}
                >
                  <PresetIcon size={11.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-ink">{preset.label}</span>
                  <span className="block truncate font-mono text-[10px] text-faint">
                    {preset.detail}
                  </span>
                </span>
                {selected ? <Check size={12} className="shrink-0 text-accent-fg" /> : null}
              </button>
            );
          })}
          <p className="mt-1 border-t border-tint/[0.06] px-2 pb-1 pt-2 text-[10.5px] leading-relaxed text-faint">
            {supported
              ? "The engine reads the frontmost window and clipboard locally — nothing leaves the machine."
              : "This host has no window reader installed. Pick a context to simulate one."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
