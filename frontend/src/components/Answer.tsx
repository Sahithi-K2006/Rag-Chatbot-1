import { Fragment, type ReactNode } from "react";
import type { Citation } from "../services/api";

/** Minimal Markdown (paragraphs, bullet/numbered lists, headings, **bold**, `code`) with
 *  clickable [n] citation markers. Text is rendered as React text nodes, never as HTML. */
export function Answer({ text, citations, onCite, streaming }: { text: string; citations: Citation[]; onCite: (c: Citation) => void; streaming?: boolean }) {
  const byId = new Map(citations.map((c) => [c.id, c]));

  const inline = (s: string, key: string): ReactNode[] => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d{1,2}\])/g);
    const isCite = (p: string | undefined) => !!p && /^\[\d{1,2}\]$/.test(p);
    return parts.map((part, i) => {
      const k = `${key}-${i}`;
      // Adjacent markers ([1][5]) get a comma so they never read as one number ("15").
      const sep = isCite(part) && parts[i - 1] === "" && isCite(parts[i - 2]) ? <sup key={`${k}s`} className="font-sans text-[0.68em] text-graphite">,</sup> : null;
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^`[^`]+`$/.test(part)) return <code key={k} className="rounded bg-paper px-1 font-sans text-[0.88em] ring-1 ring-rule">{part.slice(1, -1)}</code>;
      const m = part.match(/^\[(\d{1,2})\]$/);
      if (m) {
        const c = byId.get(Number(m[1]));
        return c ? (
          <Fragment key={k}>
          {sep}
          <button
            key={k}
            onClick={() => onCite(c)}
            className="relative -top-[0.45em] ml-[0.12em] rounded-sm px-px font-sans text-[0.68em] font-semibold text-bridge transition-colors hover:bg-wash hover:text-bridge-deep"
            aria-label={`Source ${c.id}: ${c.filename}${c.page ? `, page ${c.page}` : ""}`}
          >
            {c.id}
          </button>
          </Fragment>
        ) : streaming ? (
          <span key={k} className="relative -top-[0.45em] ml-[0.12em] px-px font-sans text-[0.68em] font-semibold text-graphite/60">
            {sep ? "," : ""}
            {m[1]}
          </span>
        ) : (
          // Markers the backend couldn't map to retrieved evidence are hidden rather than shown as fake citations.
          <Fragment key={k} />
        );
      }
      return <Fragment key={k}>{part}</Fragment>;
    });
  };

  const blocks: ReactNode[] = [];
  // Footnote markers hug the word they follow: "week [1]." renders as "week¹."
  const lines = text.replace(/[ \t]+(?=\[\d{1,2}\])/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const list = line.match(/^\s*([-*•]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={i} className={ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${i}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)/);
    if (heading) {
      blocks.push(<p key={i} className="font-sans font-semibold">{inline(heading[1], String(i))}</p>);
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={i}>{inline(para.join(" "), String(i))}</p>);
  }
  return <div className="space-y-4 font-serif text-[17px] leading-[1.7] text-ink">{blocks}</div>;
}
