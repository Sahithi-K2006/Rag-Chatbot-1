import { useRef } from "react";
import { motion } from "motion/react";
import { FileText, Library, MessageSquare, Plus, Settings, SquarePen, X } from "lucide-react";
import type { AppSettings, DocumentRecord } from "../services/api";
import { Mark } from "./brand/Mark";
import type { Conversations } from "../features/chat/useConversations";
import type { Uploads } from "../features/documents/useUploads";
import { Status, cx, spring } from "./ui";

export type Page = "home" | "chat" | "documents" | "settings";

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <Mark size={30} />
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-[-0.01em]">KnowledgeBridge</span>
        <span className="block text-[11px] font-medium text-indigo">Document intelligence</span>
      </span>
    </span>
  );
}

export function Sidebar({
  page,
  navigate,
  docs,
  chats,
  uploads,
  settings,
  onClose,
}: {
  settings: AppSettings | null;
  page: Page;
  navigate: (p: Page) => void;
  docs: DocumentRecord[] | null;
  chats: Conversations;
  uploads: Uploads;
  onClose?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const scope = chats.active.docIds;
  const ready = docs?.filter((d) => d.status === "indexed") ?? [];
  const indexing = docs?.filter((d) => d.status === "processing" || d.status === "uploaded").length ?? 0;
  const failed = docs?.filter((d) => d.status === "failed").length ?? 0;
  const kbSummary = docs === null ? "Loading…" : [`${ready.length} ready`, indexing && `${indexing} indexing`, failed && `${failed} failed`].filter(Boolean).join(", ");
  const llm = settings?.llm;
  const go = (p: Page) => {
    navigate(p);
    onClose?.();
  };
  const pickScope = (ids: string[] | null) => {
    chats.setScope(ids);
    go("chat");
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5">
      <div className="flex items-center justify-between px-2">
        <button onClick={() => go("home")} className="rounded-lg" aria-label="KnowledgeBridge home" title="Home">
          <Wordmark />
        </button>
        {onClose && (
          <button onClick={onClose} className="rounded-lg p-2 text-graphite hover:text-ink" aria-label="Close menu" autoFocus>
            <X className="size-5" />
          </button>
        )}
      </div>

      <button
        onClick={() => {
          chats.newChat();
          go("chat");
        }}
        className="flex h-10 items-center gap-2.5 rounded-xl bg-white px-3 text-[15px] font-medium shadow-[0_0_0_1px_rgb(26_32_54/0.07),var(--shadow-soft)] transition-shadow hover:shadow-[0_0_0_1px_rgb(58_86_212/0.35),var(--shadow-soft)]"
      >
        <SquarePen className="size-4" strokeWidth={1.8} /> New chat
      </button>

      <section aria-labelledby="docs-heading">
        <div className="flex items-center justify-between px-2">
          <h2 id="docs-heading" className="text-sm font-medium text-graphite">
            Knowledge base <span className="font-normal">({kbSummary})</span>
          </h2>
          <button onClick={() => fileRef.current?.click()} className="rounded-md p-1 text-graphite hover:bg-white hover:text-ink" aria-label="Upload documents" title="Upload documents">
            <Plus className="size-4" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={uploads.allowed.join(",")}
            className="hidden"
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              const ids = await uploads.uploadFiles(files);
              if (ids.length) pickScope(ids);
            }}
          />
        </div>
        <ul className="mt-2 space-y-0.5" role="radiogroup" aria-label="Documents this chat answers from">
          <ScopeRow selected={scope === null} onClick={() => pickScope(null)} label="All documents" meta="" icon={<Library className="size-4 shrink-0" strokeWidth={1.8} />} />
          {docs?.map((d) => (
            <ScopeRow
              key={d.id}
              selected={!!scope?.includes(d.id)}
              disabled={d.status !== "indexed"}
              onClick={() => pickScope([d.id])}
              label={d.filename}
              meta={d.status === "indexed" ? "" : <Status status={d.status} compact />}
              icon={<FileText className="size-4 shrink-0" strokeWidth={1.8} />}
            />
          ))}
          {uploads.uploads.map((u) => (
            <li key={u.key} className="flex items-center gap-2.5 px-2 py-1.5 text-sm text-graphite">
              <FileText className="size-4 shrink-0" strokeWidth={1.8} />
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              <span className="tabular-nums">{u.progress}%</span>
            </li>
          ))}
        </ul>
        {docs?.length === 0 && uploads.uploads.length === 0 && <p className="mt-1 px-2 text-sm text-graphite">No documents yet. Use + to upload one.</p>}
        <button onClick={() => go("documents")} className={cx("mt-2 px-2 text-sm hover:text-ink", page === "documents" ? "font-medium text-ink" : "text-graphite")}>
          Manage documents
        </button>
      </section>

      <section aria-labelledby="chats-heading" className="min-h-0 flex-1">
        <h2 id="chats-heading" className="px-2 text-sm font-medium text-graphite">
          Recent chats
        </h2>
        {chats.conversations.length === 0 ? (
          <p className="mt-1 px-2 text-sm text-graphite">Your chats will appear here.</p>
        ) : (
          <ul className="mt-2 space-y-0.5">
            {chats.conversations.map((c) => {
              const current = page === "chat" && c.id === chats.active.id;
              return (
                <li key={c.id} className="group relative">
                  {current && <motion.span layoutId="chat-marker" transition={spring} className="absolute inset-0 rounded-lg bg-white ring-1 ring-rule" />}
                  <button
                    onClick={() => {
                      chats.select(c.id);
                      go("chat");
                    }}
                    aria-current={current ? "page" : undefined}
                    className={cx("relative flex w-full items-center gap-2.5 rounded-lg py-2 pr-8 pl-2 text-left text-sm", current ? "text-ink" : "text-graphite hover:text-ink")}
                  >
                    <MessageSquare className="size-4 shrink-0" strokeWidth={1.8} />
                    <span className="truncate">{c.title}</span>
                  </button>
                  <button
                    onClick={() => chats.remove(c.id)}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-graphite opacity-0 group-hover:opacity-100 hover:text-red-700 focus-visible:opacity-100"
                    aria-label={`Delete chat ${c.title}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="space-y-2 border-t border-rule px-2 pt-4">
        <button onClick={() => go("settings")} className={cx("flex items-center gap-2.5 text-sm hover:text-ink", page === "settings" ? "font-medium text-ink" : "text-graphite")}>
          <Settings className="size-4" strokeWidth={1.8} /> Settings & help
        </button>
        {llm && (
          <p className="flex items-center gap-2 text-xs text-graphite" title={llm.ok ? "Provider ready" : "Provider not ready, see Settings"}>
            <span className={cx("size-2 shrink-0 rounded-full", llm.configured && llm.ok ? "bg-emerald-500" : "bg-amber-500")} />
            <span className="truncate">
              {llm.provider === "ollama" ? "Ollama" : "Gemini"} {llm.model}
              {llm.fallback && `, fallback ${llm.fallback}${llm.fallback_ready ? "" : " (not ready)"}`}
            </span>
          </p>
        )}
        <p className="text-xs leading-relaxed text-graphite">Answers come only from your documents. Chats are saved in this browser.</p>
      </div>
    </div>
  );
}

function ScopeRow({ selected, disabled, onClick, label, meta, icon }: { selected: boolean; disabled?: boolean; onClick: () => void; label: string; meta: React.ReactNode; icon: React.ReactNode }) {
  return (
    <li>
      <button
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onClick}
        title={disabled ? "Not ready yet" : label}
        className={cx(
          "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed",
          selected ? "bg-white font-medium text-bridge-deep shadow-[0_0_0_1px_rgb(58_86_212/0.25)]" : "text-ink hover:bg-white/70 disabled:text-graphite",
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {meta && <span className="shrink-0 text-xs text-graphite">{meta}</span>}
      </button>
    </li>
  );
}
