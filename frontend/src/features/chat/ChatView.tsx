import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, BookOpenCheck, FileText, Languages, Library, Loader2, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import { api, type AppSettings } from "../../services/api";
import type { Documents } from "../../hooks/useDocuments";
import type { Page } from "../../components/Sidebar";
import { LiquidMark } from "../../components/brand/Mark";
import { cx, spring } from "../../components/ui";
import type { Uploads } from "../documents/useUploads";
import { HeroBackdrop } from "./HeroBackdrop";
import { AssistantBubble, SourceCard, UserBubble } from "./MessageBubble";
import type { Conversations } from "./useConversations";

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

const CAPABILITIES = [
  { icon: BookOpenCheck, title: "Answers from your files", body: "Every claim links to the passage it came from, with page numbers for PDFs." },
  { icon: Languages, title: "English and Telugu", body: "Ask in English, Telugu or a mix of both, even with typos or informal wording." },
  { icon: ShieldCheck, title: "Honest about gaps", body: "If your documents don't cover something, it says so instead of guessing." },
];

export function ChatView({
  chats,
  documents,
  uploads,
  settings,
  navigate,
}: {
  chats: Conversations;
  documents: Documents;
  uploads: Uploads;
  settings: AppSettings | null;
  navigate: (p: Page) => void;
}) {
  const { active, ask, retry, stop, pending, setScope } = chats;
  const docs = documents.docs ?? [];
  const wide = useMedia("(min-width: 1280px)");
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [focus, setFocus] = useState<{ msgId: string | null; cite: number | null }>({ msgId: null, cite: null });
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const maxChars = settings?.limits.max_question_chars ?? 2000;
  const messages = active.messages;
  const last = messages[messages.length - 1];

  // ----- what this chat answers from -----
  const ready = docs.filter((d) => d.status === "indexed");
  const scoped = active.docIds ? docs.filter((d) => active.docIds!.includes(d.id)) : null;
  const waiting = scoped?.filter((d) => d.status === "processing" || d.status === "uploaded") ?? [];
  const scopeBroken = scoped !== null && scoped.length > 0 && scoped.every((d) => d.status === "failed");
  const scopeLabel = scoped === null ? `All documents${documents.docs ? ` (${ready.length} ready)` : ""}` : scoped.length === 1 ? scoped[0].filename : `${scoped.length} documents`;
  const blockedReason = waiting.length
    ? `Waiting for ${waiting.map((d) => d.filename).join(", ")} to finish indexing…`
    : scopeBroken
      ? "The selected document failed to index. Choose another one or re-index it."
      : null;

  // ----- which answer's sources the docked panel shows (wide screens) -----
  const withSources = messages.filter((m) => m.role === "assistant" && m.citations?.length);
  const panelMsg = withSources.find((m) => m.id === focus.msgId) ?? withSources[withSources.length - 1];
  const panelQuestion = panelMsg ? (messages[messages.indexOf(panelMsg) - 1]?.content ?? "") : "";
  useEffect(() => setFocus({ msgId: null, cite: null }), [active.id]);

  const scopeKey = (active.docIds ?? []).join(",");
  useEffect(() => {
    if (!ready.length) return setSuggestions([]);
    api.suggestions(active.docIds).then(setSuggestions, () => setSuggestions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, ready.length]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active.id, messages.length, last?.content.length, last?.status]);
  useEffect(() => {
    if (!pending) inputRef.current?.focus();
  }, [pending, active.id]);

  const send = (q = input) => {
    if (!q.trim() || pending || blockedReason || q.length > maxChars) return;
    ask(q);
    setInput("");
  };
  const attach = async (files: File[]) => {
    const ids = await uploads.uploadFiles(files);
    if (ids.length) setScope(ids); // keep chatting in this conversation, now answering from the new file(s)
  };
  const llm = settings?.llm;

  return (
    <div
      className="relative flex h-[calc(100dvh-3.5rem)] md:h-dvh"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        attach(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Workspace header: chat title + what it searches + model status */}
        <header className="flex items-center gap-3 border-b border-rule/80 bg-ivory/80 px-4 py-2.5 backdrop-blur sm:px-6">
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">{messages.length ? active.title : "New chat"}</h1>
          <span className={cx("hidden max-w-[45%] items-center gap-1.5 truncate rounded-full px-2.5 py-1 text-xs sm:inline-flex", scoped ? "bg-wash text-bridge-deep" : "bg-paper text-graphite")}>
            {waiting.length ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : scoped ? <FileText className="size-3.5 shrink-0" /> : <Library className="size-3.5 shrink-0" />}
            <span className="truncate">{scopeLabel}</span>
          </span>
          {llm && (
            <span className="inline-flex items-center gap-1.5 text-xs text-graphite" title={llm.ok ? `Answers by ${llm.model}` : "AI provider not ready, see Settings"}>
              <span className={cx("size-2 rounded-full", llm.configured && llm.ok ? "bg-emerald-500" : "bg-amber-500")} />
              <span className="hidden sm:inline">{llm.provider === "ollama" ? "Ollama" : "Gemini"}</span>
            </span>
          )}
        </header>

        <div className="flex-1 overflow-y-auto" aria-live="polite" aria-busy={pending}>
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            {settings && !settings.llm.configured && (
              <p role="alert" className="mt-6 rounded-xl bg-amber-50 px-4 py-3 text-[15px] text-amber-900 shadow-[inset_0_0_0_1px_rgb(217_119_6/0.25)]">
                Answers can't be generated yet: no AI provider is configured on the server.{" "}
                <button className="font-medium underline" onClick={() => navigate("settings")}>
                  Setup steps
                </button>
              </p>
            )}
            {documents.error && !documents.docs && (
              <p role="alert" className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-[15px] text-red-800 shadow-[inset_0_0_0_1px_rgb(220_38_38/0.2)]">
                {documents.error}
              </p>
            )}

            {messages.length === 0 ? (
              <div className="pt-6 pb-10 sm:pt-10">
                <section className="relative overflow-hidden rounded-[28px] px-6 py-9 shadow-[0_0_0_1px_rgb(26_32_54/0.06),var(--shadow-soft)] sm:px-10 sm:py-12">
                  <HeroBackdrop />
                  <div className="relative">
                    <LiquidMark size={64} />
                    <motion.h2
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                      className="mt-6 max-w-lg text-[clamp(1.7rem,3.6vw,2.4rem)] leading-[1.12] font-medium tracking-[-0.02em]"
                    >
                      Ask your documents. Get answers you can check.
                    </motion.h2>
                    <p className="mt-3 max-w-md text-[15px] leading-relaxed text-graphite">
                      {ready.length
                        ? `${ready.length} document${ready.length === 1 ? " is" : "s are"} ready. Ask a question below, or attach another file.`
                        : "Attach a PDF, TXT or Markdown file with the paperclip below, or drop it anywhere here. You can also just say hello."}
                    </p>
                  </div>
                </section>

                <ul className="mt-5 grid gap-3 sm:grid-cols-3">
                  {CAPABILITIES.map(({ icon: Icon, title, body }) => (
                    <li key={title} className="rounded-2xl bg-white/70 p-4 shadow-[0_0_0_1px_rgb(26_32_54/0.06)]">
                      <Icon className="size-[18px] text-indigo" strokeWidth={1.8} />
                      <p className="mt-2.5 text-sm font-medium">{title}</p>
                      <p className="mt-1 text-[13px] leading-relaxed text-graphite">{body}</p>
                    </li>
                  ))}
                </ul>

                {suggestions.length > 0 && (
                  <div className="mt-8">
                    <p className="text-sm font-medium text-graphite">Try asking</p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {suggestions.slice(0, 4).map((s) => (
                        <button
                          key={s}
                          onClick={() => {
                            setInput(s);
                            inputRef.current?.focus();
                          }}
                          className="rounded-full bg-white px-3.5 py-2 text-left text-sm shadow-[0_0_0_1px_rgb(26_32_54/0.08)] transition-shadow hover:shadow-[0_0_0_1px_rgb(58_86_212/0.4)]"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-7 py-8">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <UserBubble key={m.id} m={m} />
                  ) : (
                    <AssistantBubble
                      key={m.id}
                      m={m}
                      question={messages[i - 1]?.content ?? ""}
                      onRetry={() => messages[i - 1] && retry(messages[i - 1].id)}
                      inlineSources={!wide}
                      activeCitation={(wide ? panelMsg?.id === m.id : focus.msgId === m.id) ? focus.cite : null}
                      onCite={(cite) => setFocus({ msgId: m.id, cite })}
                    />
                  ),
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="px-4 pt-2 pb-4 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className={cx("inline-flex max-w-full items-center gap-1.5 rounded-full py-1 pr-1 pl-2.5", scoped ? "bg-wash text-bridge-deep" : "bg-white/80 text-graphite shadow-[0_0_0_1px_rgb(26_32_54/0.07)]")}>
                {scoped ? <FileText className="size-3.5 shrink-0" /> : <Library className="size-3.5 shrink-0" />}
                <span className="truncate">Answering from {scopeLabel}</span>
                {waiting.length > 0 && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Indexing" />}
                {scoped && (
                  <button onClick={() => setScope(null)} className="rounded-full p-0.5 hover:bg-white" aria-label="Answer from all documents instead">
                    <X className="size-3.5" />
                  </button>
                )}
              </span>
              {uploads.uploads.map((u) => (
                <span key={u.key} className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 text-graphite shadow-[0_0_0_1px_rgb(26_32_54/0.07)]">
                  <Loader2 className="size-3.5 animate-spin" /> Uploading {u.name} {u.progress}%
                </span>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="glass flex items-end gap-1.5 rounded-[22px] p-1.5 transition-shadow focus-within:shadow-[inset_0_1px_0_rgb(255_255_255/0.95),0_0_0_2px_rgb(58_86_212/0.55),var(--shadow-float)]"
            >
              <button type="button" onClick={() => fileRef.current?.click()} className="grid size-10 shrink-0 place-items-center rounded-2xl text-graphite transition-colors hover:bg-wash hover:text-indigo" aria-label="Attach documents" title="Attach PDF, TXT or Markdown">
                <Paperclip className="size-[18px]" strokeWidth={1.8} />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={uploads.allowed.join(",")}
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  attach(files);
                }}
              />
              <label htmlFor="question" className="sr-only">
                Message KnowledgeBridge AI
              </label>
              <textarea
                id="question"
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="Ask about your documents…"
                className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-[16px] outline-none placeholder:text-graphite/70 [field-sizing:content] focus-visible:outline-none"
              />
              <AnimatePresence mode="popLayout" initial={false}>
                {pending ? (
                  <motion.button key="stop" type="button" onClick={stop} aria-label="Stop generating" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={spring} className="grid size-10 shrink-0 place-items-center rounded-2xl bg-white text-ink shadow-[0_0_0_1px_rgb(26_32_54/0.1)]">
                    <Square className="size-3.5 fill-current" />
                  </motion.button>
                ) : (
                  <motion.button
                    key="send"
                    type="submit"
                    aria-label="Send message"
                    disabled={!input.trim() || !!blockedReason || input.length > maxChars}
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.5, opacity: 0 }}
                    whileTap={{ scale: 0.9 }}
                    transition={spring}
                    className="grid size-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-b from-bridge to-indigo text-white shadow-[0_6px_16px_-6px_rgb(81_70_201/0.7)] transition-opacity disabled:from-rule disabled:to-rule disabled:text-graphite disabled:shadow-none"
                  >
                    <ArrowUp className="size-[18px]" strokeWidth={2.2} />
                  </motion.button>
                )}
              </AnimatePresence>
            </form>
            <p className="mt-2 flex justify-between gap-4 px-1 text-xs text-graphite">
              <span className={cx(blockedReason && "text-amber-800")}>{blockedReason ?? `Enter to send, Shift + Enter for a new line. Files up to ${uploads.maxMb} MB.`}</span>
              <span className={cx("shrink-0", input.length > maxChars && "font-medium text-red-700")}>{input.length > maxChars * 0.8 && `${input.length}/${maxChars}`}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Docked citation panel (wide screens). Narrower screens show sources under each answer. */}
      {wide && (
        <aside aria-label="Sources" className="flex w-[340px] shrink-0 flex-col border-l border-rule/80 bg-paper/60">
          <div className="border-b border-rule/80 px-5 py-3">
            <h2 className="text-[15px] font-medium">Sources</h2>
            <p className="text-xs text-graphite">{panelMsg ? "Passages behind the selected answer" : "Passages will appear here"}</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {panelMsg ? (
              <>
                <p className="mb-3 line-clamp-2 text-sm text-graphite">For: “{panelQuestion}”</p>
                <ul className="space-y-2">
                  {panelMsg.citations!.map((c) => (
                    <SourceCard
                      key={c.id}
                      c={c}
                      question={panelQuestion}
                      open={focus.msgId === panelMsg.id ? focus.cite === c.id : false}
                      onToggle={() => setFocus({ msgId: panelMsg.id, cite: focus.msgId === panelMsg.id && focus.cite === c.id ? null : c.id })}
                    />
                  ))}
                </ul>
              </>
            ) : (
              <div className="mt-10 text-center">
                <FileText className="mx-auto size-8 text-rule" strokeWidth={1.5} />
                <p className="mt-3 text-sm text-graphite">When an answer uses your documents, its passages show up here. Click a citation number to open one.</p>
              </div>
            )}
          </div>
        </aside>
      )}

      <AnimatePresence>
        {dragging && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-[28px] border-2 border-dashed border-bridge/60 bg-wash/85 backdrop-blur-sm">
            <div className="text-center">
              <p className="text-lg font-medium">Drop to add to this chat</p>
              <p className="mt-1 text-sm text-graphite">PDF, TXT or Markdown, up to {uploads.maxMb} MB each</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
