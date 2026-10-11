import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MessageSquare, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, formatBytes, formatDate, type DocStatus, type DocumentRecord } from "../../services/api";
import type { Documents } from "../../hooks/useDocuments";
import { Button, ConfirmDialog, Skeleton, Status, cx, spring, useToast } from "../../components/ui";
import type { Uploads } from "./useUploads";

type Filter = "all" | DocStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "indexed", label: "Ready" },
  { id: "processing", label: "Indexing" },
  { id: "failed", label: "Failed" },
];
const KIND: Record<string, string> = { ".pdf": "PDF", ".txt": "Text", ".md": "Markdown" };

export function DocumentsPage({
  documents,
  uploads: up,
  onDeleted,
  onChat,
}: {
  documents: Documents;
  uploads: Uploads;
  onDeleted: (docId: string) => void;
  onChat: (docId: string) => void;
}) {
  const { docs, error, refresh, setDocs } = documents;
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [toDelete, setToDelete] = useState<DocumentRecord | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const { uploads, uploadFiles, allowed, maxMb } = up;

  // The whole page accepts dropped files.
  const uploadRef = useRef<(files: File[]) => void>(() => {});
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      uploadRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  uploadRef.current = uploadFiles;

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((s) => new Set(s).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const remove = (doc: DocumentRecord) =>
    withBusy(doc.id, async () => {
      try {
        await api.deleteDocument(doc.id);
        setDocs((d) => d?.filter((x) => x.id !== doc.id) ?? null);
        onDeleted(doc.id);
        toast("success", `Removed ${doc.filename}.`);
      } catch (e) {
        toast("error", `Couldn't remove ${doc.filename}. ${(e as Error).message}`);
      }
    });

  const reindex = (doc: DocumentRecord) =>
    withBusy(doc.id, async () => {
      try {
        const updated = await api.reindex(doc.id);
        up.watch(doc.id);
        setDocs((d) => d?.map((x) => (x.id === doc.id ? updated : x)) ?? null);
      } catch (e) {
        toast("error", `Couldn't re-index ${doc.filename}. ${(e as Error).message}`);
      }
    });

  const matches = (d: DocumentRecord, f: Filter) => f === "all" || d.status === f || (f === "processing" && d.status === "uploaded");
  const shown = (docs ?? []).filter((d) => matches(d, filter));
  const count = (f: Filter) => docs?.filter((d) => matches(d, f)).length ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-xl">
          <h1 className="text-3xl font-medium tracking-[-0.02em]">Knowledge base</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-graphite">
            Drop files anywhere on this page, or choose them. PDF, TXT and Markdown, up to {maxMb} MB each. A document can be asked about once its status is Ready. Scanned image-only PDFs need OCR, which isn't included.
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={RefreshCw} onClick={() => refresh()} aria-label="Refresh list" />
          <Button variant="primary" icon={Plus} onClick={() => inputRef.current?.click()}>
            Add documents
          </Button>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={allowed.join(",")}
        className="hidden"
        onChange={(e) => {
          uploadFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      <div className="mt-8 flex gap-1 overflow-x-auto border-b border-rule" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cx("relative shrink-0 px-3 pb-3 pt-1 text-[15px] transition-colors", filter === f.id ? "text-ink" : "text-graphite hover:text-ink")}
          >
            {f.label}
            <span className="ml-1.5 text-sm tabular-nums text-graphite">{count(f.id)}</span>
            {filter === f.id && <motion.span layoutId="filter-underline" transition={spring} className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-ink" />}
          </button>
        ))}
      </div>

      <ul className="divide-y divide-rule">
        <AnimatePresence initial={false}>
          {uploads.map((u) => (
            <motion.li key={u.key} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring} className="overflow-hidden">
              <div className="flex items-center gap-4 py-4">
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{u.name}</span>
                <span className="text-sm tabular-nums text-graphite">Uploading {u.progress}%</span>
              </div>
              <div className="-mt-1 mb-3 h-0.5 overflow-hidden rounded-full bg-rule" role="progressbar" aria-valuenow={u.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${u.name}`}>
                <motion.div className="h-full bg-bridge" animate={{ width: `${u.progress}%` }} transition={spring} />
              </div>
            </motion.li>
          ))}

          {error && docs === null ? (
            <li key="error" className="py-10">
              <p className="text-[15px] text-red-700">{error}</p>
              <Button className="mt-3" onClick={refresh}>
                Try again
              </Button>
            </li>
          ) : docs === null ? (
            [0, 1, 2].map((i) => (
              <li key={`sk${i}`} className="py-4">
                <Skeleton className="h-10 w-full" />
              </li>
            ))
          ) : shown.length === 0 && uploads.length === 0 ? (
            <motion.li key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-14">
              <p className="font-serif text-xl">{docs.length ? "No documents in this view." : "No documents yet."}</p>
              <p className="mt-2 max-w-md text-[15px] text-graphite">
                {docs.length
                  ? "Switch the filter above to see the rest."
                  : "Try the fictional samples in backend/sample_docs: a handbook, a policy update, a product FAQ and a returns policy PDF."}
              </p>
            </motion.li>
          ) : (
            shown.map((d) => {
              const busy = busyIds.has(d.id);
              const working = d.status === "processing" || d.status === "uploaded";
              return (
                <motion.li
                  key={d.id}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }}
                  transition={spring}
                  className="relative overflow-hidden"
                >
                  <div className="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[1fr_7rem_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-medium">{d.filename}</p>
                      <p className="text-sm text-graphite">
                        {KIND[d.ext] ?? d.ext}, {formatBytes(d.size_bytes)}, added {formatDate(d.uploaded_at)}
                        {d.status === "indexed" && `. ${d.chunk_count} passage${d.chunk_count === 1 ? "" : "s"}${d.page_count ? ` from ${d.page_count} pages` : ""}`}
                      </p>
                      {d.status === "failed" && d.error && <p className="mt-1 text-sm text-red-700">{d.error} Use Re-index to try again.</p>}
                    </div>
                    <div className="flex items-center justify-between sm:contents">
                    <Status status={d.status} />
                    <div className="flex items-center gap-1 sm:justify-end">
                      {d.status === "indexed" && (
                        <button
                          onClick={() => onChat(d.id)}
                          aria-label={`Chat about ${d.filename}`}
                          title="Chat about this document"
                          className="rounded-md p-2 text-graphite transition-colors hover:bg-wash hover:text-bridge-deep"
                        >
                          <MessageSquare className="size-4" strokeWidth={1.8} />
                        </button>
                      )}
                      <button
                        onClick={() => reindex(d)}
                        disabled={working || busy}
                        className="rounded-md px-2 py-1.5 text-sm text-graphite transition-colors hover:bg-paper hover:text-ink disabled:opacity-40"
                      >
                        Re-index
                      </button>
                      <button
                        onClick={() => setToDelete(d)}
                        disabled={busy}
                        aria-label={`Remove ${d.filename}`}
                        className="rounded-md p-2 text-graphite transition-colors hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                      >
                        <Trash2 className="size-4" strokeWidth={1.8} />
                      </button>
                    </div>
                    </div>
                  </div>
                  {working && (
                    <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" aria-hidden>
                      <motion.div className="h-full w-1/3 bg-amber-400" animate={{ x: ["-100%", "300%"] }} transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }} />
                    </div>
                  )}
                </motion.li>
              );
            })
          )}
        </AnimatePresence>
      </ul>

      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-wash/85 backdrop-blur-[2px]"
          >
            <motion.div initial={{ scale: 0.94 }} animate={{ scale: 1 }} transition={spring} className="rounded-2xl border-2 border-dashed border-bridge bg-white px-12 py-10 text-center">
              <p className="text-xl font-medium">Drop to add to your knowledge base</p>
              <p className="mt-1 text-[15px] text-graphite">PDF, TXT or Markdown, up to {maxMb} MB each</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={toDelete !== null}
        title={`Remove ${toDelete?.filename ?? "document"}?`}
        body="Its passages leave the index and answers stop citing it. The original file on your computer is not affected."
        confirmLabel="Remove"
        onConfirm={() => toDelete && remove(toDelete)}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
