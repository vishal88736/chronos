"use client";

import React from "react";
import clsx from "clsx";
import type { SourceChunk } from "@/types/chronos";

interface StructuredAnswerProps {
  content: string;
  sources: SourceChunk[];
  onCitationHover: (sourceId: string | null) => void;
  className?: string;
}

type Block =
  | { kind: "heading"; label: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string; marker: string }
  | { kind: "note"; text: string };

/** `**Answer**`, `# Answer` and `Answer:` on their own line become section labels. */
const HEADING_RE = /^\s*(?:\*\*([^*]{2,48})\*\*|#{1,4}\s+([^#]{2,48}))\s*:?\s*$/;
const BULLET_RE = /^\s*[-•*]\s+(.+)$/;
const NUMBERED_RE = /^\s*(\d{1,2})[.)]\s+(.+)$/;
const NOTE_RE = /^\s*>\s?(.*)$/;
const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[src_\d+\])/g;

/**
 * Parses the small, fixed subset of markdown the engine emits — bold section
 * labels, hyphen bullets and quote-footnotes — into renderable blocks. This is
 * deliberately not a general markdown parser: the answer is untrusted text and
 * every branch here renders React nodes, never HTML.
 */
function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
    paragraph.length = 0;
  };

  // While streaming, a half-typed marker ("**" or "- ") is common; drop only a
  // trailing empty one so it never flashes as literal text.
  const lines = content.replace(/\n?\*\*\s*$/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const label = (heading[1] ?? heading[2] ?? "").trim().replace(/[.:;,]+$/, "");
      if (label && label.split(/\s+/).length <= 7) {
        flush();
        blocks.push({ kind: "heading", label });
        continue;
      }
    }

    const note = line.match(NOTE_RE);
    if (note) {
      flush();
      const text = note[1].trim();
      if (text) blocks.push({ kind: "note", text });
      continue;
    }

    const numbered = line.match(NUMBERED_RE);
    if (numbered) {
      flush();
      blocks.push({ kind: "bullet", text: numbered[2].trim(), marker: numbered[1] });
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      flush();
      blocks.push({ kind: "bullet", text: bullet[1].trim(), marker: "" });
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function Inline({
  text,
  sources,
  onCitationHover,
}: {
  text: string;
  sources: SourceChunk[];
  onCitationHover: (sourceId: string | null) => void;
}) {
  const parts = text.split(INLINE_RE);
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;

        const citation = part.match(/^\[(src_\d+)\]$/);
        if (citation) {
          const sourceId = citation[1];
          const source = sources.find((item) => item.id === sourceId);
          return (
            <button
              key={`${sourceId}-${index}`}
              type="button"
              className="citation-pill"
              aria-label={`Highlight ${sourceId}${source ? ` — ${source.title}` : ""} in the glass-box inspector`}
              title={
                source
                  ? `${source.title} · ${source.domain || "unknown host"} · composite ${source.composite_score.toFixed(2)}`
                  : sourceId
              }
              onMouseEnter={() => onCitationHover(sourceId)}
              onMouseLeave={() => onCitationHover(null)}
              onFocus={() => onCitationHover(sourceId)}
              onBlur={() => onCitationHover(null)}
            >
              [{sourceId}]
            </button>
          );
        }

        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={`bold-${index}`} className="font-semibold text-ink-strong">
              {part.slice(2, -2)}
            </strong>
          );
        }

        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code
              key={`code-${index}`}
              className="rounded-[4px] border border-tint/[0.06] bg-tint/[0.03] px-1 font-mono text-[11.5px] text-cached-fg"
            >
              {part.slice(1, -1)}
            </code>
          );
        }

        return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
      })}
    </>
  );
}

export default function StructuredAnswer({
  content,
  sources,
  onCitationHover,
  className,
}: StructuredAnswerProps) {
  const blocks = parseBlocks(content);

  return (
    <div className={clsx("relative", className)}>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <div
              key={`heading-${index}`}
              className={clsx("flex items-center gap-2.5", index === 0 ? "" : "mt-5")}
            >
              <span className="h-[3px] w-[3px] rounded-full bg-accent/70" />
              <span className="font-mono text-[10px] uppercase tracking-[0.17em] text-faint">
                {block.label}
              </span>
              <span className="h-px flex-1 bg-gradient-to-r from-tint/[0.07] to-transparent" />
            </div>
          );
        }

        if (block.kind === "note") {
          return (
            <div
              key={`note-${index}`}
              className="mt-4 rounded-[9px] border border-tint/[0.055] bg-tint/[0.018] px-3 py-2 text-[11.5px] leading-[1.6] text-faint"
            >
              <Inline
                text={block.text}
                sources={sources}
                onCitationHover={onCitationHover}
              />
            </div>
          );
        }

        if (block.kind === "bullet") {
          // Consecutive bullets keep even rhythm by tightening their spacing.
          const previous = blocks[index - 1];
          const startsList = !previous || previous.kind !== "bullet";
          const marker = block.marker || null;
          return (
            <div
              key={`bullet-${index}`}
              className={clsx(
                "flex items-start gap-2.5",
                startsList ? "mt-2.5" : "mt-2",
              )}
            >
              {marker ? (
                <span className="mt-[1px] w-4 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
                  {marker}
                </span>
              ) : (
                <span className="mt-[9px] h-[4px] w-[4px] shrink-0 rounded-full bg-accent/60" />
              )}
              <span className="min-w-0 flex-1 text-[13px] leading-[1.72] text-ink/95">
                <Inline
                  text={block.text}
                  sources={sources}
                  onCitationHover={onCitationHover}
                />
              </span>
            </div>
          );
        }

        return (
          <p
            key={`paragraph-${index}`}
            className={clsx(
              "text-[13.5px] leading-[1.78] tracking-[-0.006em] text-ink/95",
              index === 0 ? "" : "mt-2.5",
            )}
          >
            <Inline text={block.text} sources={sources} onCitationHover={onCitationHover} />
          </p>
        );
      })}
    </div>
  );
}
