"use client";

import { useState } from "react";
import clsx from "clsx";
import {
  BellRing,
  Check,
  ChevronDown,
  ClipboardCopy,
  Clock3,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import type { NudgePayload } from "@/types/chronos";

interface NudgePillProps {
  nudge: NudgePayload;
  onDismiss: () => void;
  onResolve: (promiseId: string) => Promise<void>;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
  }
}

export default function NudgePill({ nudge, onDismiss, onResolve }: NudgePillProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const urgencyClass =
    nudge.urgency >= 4
      ? "border-healing/25 bg-healing/[0.11] text-amber-200"
      : nudge.urgency >= 3
        ? "border-cached/25 bg-cached/[0.1] text-cyan-200"
        : "border-accent/25 bg-accent/[0.12] text-indigo-200";

  async function handleCopyResolve() {
    if (!nudge.draft_artifact || resolving) return;
    setCopyError(false);
    const copiedOk = await copyToClipboard(nudge.draft_artifact);
    setCopied(copiedOk);
    setCopyError(!copiedOk);
    setResolving(true);
    try {
      await onResolve(nudge.promise_id);
    } finally {
      setResolving(false);
    }
  }

  return (
    <section
      className="nudge-island glass-popover relative mx-auto w-full max-w-[660px] overflow-hidden rounded-[18px]"
      aria-label="Caught promise ready"
      aria-live="polite"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/45 to-transparent" />
      <div className="pointer-events-none absolute -left-10 -top-14 h-32 w-32 rounded-full bg-healing/[0.06] blur-3xl" />

      <div className="relative px-4 pb-3 pt-3.5">
        <div className="flex items-start gap-3">
          <div className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-healing/20 bg-healing/[0.09] text-amber-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
            <BellRing size={15} strokeWidth={2} />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-[#141722] bg-healing shadow-[0_0_9px_rgba(245,158,11,0.7)]" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-amber-300/90">
                Caught promise ready
              </span>
              <span className="h-[3px] w-[3px] rounded-full bg-faint" aria-hidden="true" />
              <span className="flex items-center gap-1 text-[9.5px] text-muted">
                <Clock3 size={9.5} />
                focus gate passed
              </span>
              <span
                className={clsx(
                  "ml-auto flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[9px] tabular-nums tracking-[0.02em]",
                  urgencyClass,
                )}
              >
                <span className="text-[8px] uppercase tracking-[0.08em] opacity-60">urgency</span>
                {nudge.urgency.toFixed(1)}
              </span>
            </div>

            <p className="mt-2 line-clamp-3 text-[13px] font-medium leading-[1.5] tracking-[-0.01em] text-zinc-100">
              {nudge.trigger_summary}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted">
              <span className="text-zinc-400">
                {nudge.recipient}
                <span className="mx-1.5 text-faint">·</span>
              </span>
              <span className="truncate">{nudge.promised_action}</span>
              <span className="ml-auto hidden font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint sm:inline">
                P × T / F = {nudge.urgency.toFixed(2)}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="Dismiss nudge"
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>

        <div className="mt-3 rounded-[11px] border border-white/[0.075] bg-black/20">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 rounded-[11px] px-3 py-2 text-left transition-colors hover:bg-white/[0.025]"
          >
            <Sparkles size={11.5} className="text-indigo-300" />
            <span className="text-[10.5px] font-medium text-zinc-300">
              Pre-staged action artifact
            </span>
            <span className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-faint">
              {nudge.draft_artifact ? "ready" : "empty"}
            </span>
            <ChevronDown
              size={13}
              className={clsx(
                "ml-auto text-faint transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </button>

          {expanded ? (
            <div className="animate-fade-in border-t border-white/[0.06] px-3 pb-3 pt-2.5">
              <pre className="scrollbar-subtle max-h-44 overflow-y-auto whitespace-pre-wrap font-sans text-[11.5px] leading-relaxed text-zinc-300">
                {nudge.draft_artifact ??
                  "No draft was attached to this nudge. Resolve it and ask Chronos for a fresh action draft."}
              </pre>
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopyResolve}
            disabled={resolving || !nudge.draft_artifact}
            className="group inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-[9px] border border-indigo-400/25 bg-gradient-to-b from-indigo-500/[0.24] to-indigo-500/[0.16] px-3 text-[11px] font-medium text-indigo-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_8px_20px_rgba(99,102,241,0.08)] transition-all hover:from-indigo-500/[0.32] hover:to-indigo-500/[0.2] disabled:cursor-not-allowed disabled:opacity-65 sm:flex-none"
          >
            {resolving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : copied ? (
              <Check size={12} />
            ) : (
              <ClipboardCopy size={12} />
            )}
            {resolving
              ? "Resolving promise…"
              : copied
                ? "Copied — resolving"
                : "Copy draft & resolve"}
          </button>
          {nudge.draft_artifact ? (
            <span className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">
              clipboard ready
            </span>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto text-[10.5px] text-muted transition-colors hover:text-zinc-200"
          >
            Dismiss
          </button>
        </div>
        {copyError ? (
          <p className="mt-2 text-[10px] text-rose-300">
            Clipboard permission was denied. Select the draft manually from the accordion.
          </p>
        ) : null}
      </div>
    </section>
  );
}
