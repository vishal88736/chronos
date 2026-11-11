"use client";

import { useEffect } from "react";
import clsx from "clsx";
import { ShieldCheck, X } from "lucide-react";

interface AutoVerifiedBannerProps {
  note: string;
  recipient: string;
  onDismiss: () => void;
}

/**
 * The "stayed quiet" toast.
 *
 * Chronos closing a promise without interrupting anyone is a *good* outcome,
 * so this reads as a calm confirmation rather than an error.
 */
export default function AutoVerifiedBanner({
  note,
  recipient,
  onDismiss,
}: AutoVerifiedBannerProps) {
  useEffect(() => {
    const timeout = window.setTimeout(onDismiss, 12000);
    return () => window.clearTimeout(timeout);
  }, [onDismiss]);

  return (
    <div
      className="animate-fade-up flex items-start gap-2.5 rounded-[12px] border border-healthy/25 bg-healthy/[0.07] px-3.5 py-3"
      role="status"
      aria-live="polite"
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-healthy/25 bg-healthy/[0.12] text-healthy-fg">
        <ShieldCheck size={13} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-healthy-fg/90">
          Stayed quiet · auto-verified
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink">
          Chronos detected you already fulfilled your promise to{" "}
          <span className="font-medium text-ink-strong">{recipient}</span>. Zero interruption
          triggered.
        </p>
        {note ? (
          <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-healthy-fg/70">
            {note}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className={clsx(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint",
          "transition-colors hover:bg-tint/[0.06] hover:text-ink",
        )}
        aria-label="Dismiss auto-verification notice"
      >
        <X size={11} />
      </button>
    </div>
  );
}
