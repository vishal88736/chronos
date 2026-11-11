"use client";

import { useId } from "react";

/**
 * The Chronos mark: a chronograph dial with an open ring and swept hands.
 * The open ring doubles as a "C", and the hands read as time — the product
 * watches the web on the user's behalf.
 */
export function ChronosMark({ size = 26 }: { size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tile = `chronos-tile-${id}`;
  const ring = `chronos-ring-${id}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      role="img"
    >
      <defs>
        <linearGradient id={tile} x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0B1717" />
          <stop offset="1" stopColor="#123029" />
        </linearGradient>
        <linearGradient id={ring} x1="6" y1="26" x2="26" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0D9488" />
          <stop offset="0.55" stopColor="#10B981" />
          <stop offset="1" stopColor="#A7F3D0" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill={`url(#${tile})`} />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="9"
        stroke="rgba(167,243,208,0.16)"
      />
      <path
        d="M22.9 10.2a9 9 0 1 0 0 11.6"
        stroke={`url(#${ring})`}
        strokeWidth="2.1"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M16 10.9V16l4.4 2.3"
        stroke="#C7F9E5"
        strokeOpacity="0.9"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="16" cy="16" r="1.7" fill="#6EE7B7" />
    </svg>
  );
}

export function ChronosLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className="no-drag flex shrink-0 items-center gap-2.5" aria-label="Chronos">
      <ChronosMark size={26} />
      {compact ? null : (
        <div className="hidden flex-col leading-none sm:flex">
          <span className="font-display text-[15.5px] tracking-[-0.02em] text-ink-strong">
            Chronos
          </span>
          <span className="mt-[3px] font-mono text-[8px] uppercase tracking-[0.24em] text-faint">
            glass-box engine
          </span>
        </div>
      )}
    </div>
  );
}
