import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, ChevronDown, Copy, FileText, RotateCcw } from "lucide-react";
import type { Citation } from "../../services/api";
import { Answer } from "../../components/Answer";
import { Mark } from "../../components/brand/Mark";
import { Button, cx, spring, useToast } from "../../components/ui";
import type { Message } from "./useConversations";

const STOP = new Set(
  "the a an and or of to in on for with what which who whom how why when where is are was were do does did can could should would about from that this these those there their have has into than then your you our per many much any some".split(" "),
);
const termsOf = (q: string) => [...new Set(q.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])].filter((t) => !STOP.has(t));

/** Marks the question's key words inside an excerpt so readers can see why it matched. */
function highlight(text: string, question: string): ReactNode {
  const terms = termsOf(question);
  if (!terms.length) return text;
  const re = new RegExp(`\\b(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\w*`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

export function SourceCard({ c, question, open, onToggle }: { c: Citation; question: string; open: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);
  return (
    <motion.li ref={ref} layout transition={spring} className={cx("overflow-hidden rounded-xl bg-white transition-shadow", open ? "shadow-[0_0_0_1.5px_rgb(58_86_212/0.45),var(--shadow-soft)]" : "shadow-[0_0_0_1px_rgb(26_32_54/0.07)]")}>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm">
        <span className={cx("grid size-5 shrink-0 place-items-center rounded-md text-[11px] font-semibold", open ? "bg-bridge text-white" : "bg-wash text-indigo")}>{c.id}</span>
        <FileText className="size-3.5 shrink-0 text-graphite" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate font-medium">{c.filename}</span>
        {c.page && <span className="shrink-0 text-xs text-graphite">p. {c.page}</span>}
        <ChevronDown className={cx("size-4 shrink-0 text-graphite transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring}>
            <blockquote className="mx-3 max-h-72 overflow-y-auto border-l-2 border-marker pl-3 font-serif text-[14.5px] leading-relaxed whitespace-pre-wrap">{highlight(c.text, question)}</blockquote>
            <p className="px-3 py-2.5 text-xs leading-relaxed text-graphite">
              Passage {c.chunk_index + 1}
              {c.page ? ` on page ${c.page}` : ""}
              {c.score !== null ? `. Match score ${c.score.toFixed(2)}: wording similarity to your question, not proof the answer is right.` : ". Chosen to represent the document for an overview."}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

const ERROR_TITLE: Record<string, string> = {
  llm_quota_exhausted: "AI quota used up",
  llm_rate_limit: "Too many requests right now",
  llm_timeout: "The model took too long",
  llm_network: "Can't reach the AI provider",
  network: "Can't reach the KnowledgeBridge server",
  llm_auth: "AI provider rejected the key",
  llm_model: "Model not available",
  llm_not_configured: "No AI provider configured",
  llm_unavailable: "AI provider unavailable",
  retrieval_failed: "Search failed",
  stopped: "Stopped",
};

const MODE_NOTE: Partial<Record<NonNullable<Message["mode"]>, string>> = {
  no_evidence: "Not found in your documents",
  no_documents: "No documents ready yet",
};

const PROVIDER_NAME: Record<string, string> = { gemini: "Gemini", ollama: "Ollama" };

export function UserBubble({ m }: { m: Message }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="flex justify-end">
      <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-wash px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink shadow-[inset_0_0_0_1px_rgb(81_70_201/0.10)]">{m.content}</div>
    </motion.div>
  );
}

export function AssistantBubble({
  m,
  question,
  onRetry,
  activeCitation,
  onCite,
  inlineSources,
}: {
  m: Message;
  question: string;
  onRetry: () => void;
  activeCitation: number | null;
  onCite: (id: number | null) => void;
  /** false on wide screens, where sources are shown in the docked panel instead */
  inlineSources: boolean;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const citations = m.citations ?? [];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("error", "Couldn't copy to the clipboard.");
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="flex gap-3">
      <Mark size={28} className="mt-1 shrink-0 self-start" />
      <div className="min-w-0 flex-1">
        <div className="card px-5 py-4">
          {m.content ? (
            <Answer text={m.content} citations={citations} onCite={(c) => onCite(c.id)} streaming={m.status === "streaming"} />
          ) : (
            m.status === "streaming" && (
              <p className="flex items-center gap-2 py-0.5 text-[15px] text-graphite" aria-label="Thinking">
                Reading your documents
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <motion.span key={i} className="size-1 rounded-full bg-indigo" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1.1, delay: i * 0.18 }} />
                  ))}
                </span>
              </p>
            )
          )}
          {m.status === "error" && (
            <div role="alert" className={cx("rounded-xl bg-red-50/70 px-3.5 py-3 text-[15px] shadow-[inset_0_0_0_1px_rgb(220_38_38/0.15)]", m.content && "mt-3")}>
              <p className="flex items-center gap-2 font-medium text-red-800">
                <AlertTriangle className="size-4 shrink-0" strokeWidth={2} /> {ERROR_TITLE[m.errorCode ?? ""] ?? "Couldn't answer"}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-red-900/80">{m.error}</p>
              {m.errorCode !== "llm_not_configured" && (
                <Button icon={RotateCcw} onClick={onRetry} className="mt-2.5">
                  Try again
                </Button>
              )}
            </div>
          )}
        </div>

        {m.status === "done" && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-1 text-xs text-graphite">
            {m.mode && MODE_NOTE[m.mode] && (
              <span className="flex items-center gap-1.5 text-amber-800">
                <span className="size-1.5 rounded-full bg-amber-500" aria-hidden /> {MODE_NOTE[m.mode]}
              </span>
            )}
            {(m.mode === "document" || m.mode === "summary") && !m.grounded && (
              <span className="flex items-center gap-1.5 text-amber-800">
                <span className="size-1.5 rounded-full bg-amber-500" aria-hidden /> No passage cited for this answer
              </span>
            )}
            {citations.length > 0 && !inlineSources && (
              <button onClick={() => onCite(activeCitation ?? citations[0].id)} className="rounded px-1 py-0.5 font-medium text-bridge hover:bg-white">
                {citations.length} source{citations.length > 1 ? "s" : ""}
              </button>
            )}
            {m.provider && (
              <span>
                Answered by {PROVIDER_NAME[m.provider] ?? m.provider}
                {m.fallbackReason && " (fallback: primary provider unavailable)"}
              </span>
            )}
            <button onClick={copy} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white hover:text-ink">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}

        {inlineSources && citations.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 pl-1 text-xs font-medium text-graphite">Sources ({citations.length})</p>
            <ul className="space-y-1.5">
              {citations.map((c) => (
                <SourceCard key={c.id} c={c} question={question} open={activeCitation === c.id} onToggle={() => onCite(activeCitation === c.id ? null : c.id)} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </motion.div>
  );
}
