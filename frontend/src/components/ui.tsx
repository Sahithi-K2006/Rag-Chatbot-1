import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, X, type LucideIcon } from "lucide-react";
import type { DocStatus } from "../services/api";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Spring used for everything that moves in response to the user. */
export const spring = { type: "spring", stiffness: 520, damping: 38, mass: 0.8 } as const;

type Variant = "primary" | "quiet" | "danger" | "link";
const variants: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-bridge-deep disabled:bg-graphite/40",
  quiet: "text-ink ring-1 ring-inset ring-rule bg-white hover:ring-graphite/40 disabled:text-graphite/50",
  danger: "bg-red-700 text-white hover:bg-red-800",
  link: "text-bridge hover:text-bridge-deep underline-offset-4 hover:underline px-0! h-auto!",
};

export function Button({
  variant = "quiet",
  icon: Icon,
  loading,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: LucideIcon; loading?: boolean }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      transition={spring}
      {...(props as object)}
      disabled={props.disabled || loading}
      className={cx(
        "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed",
        variants[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : Icon && <Icon className="size-4" aria-hidden strokeWidth={1.8} />}
      {children}
    </motion.button>
  );
}

const statusText: Record<DocStatus, { label: string; dot: string; text: string }> = {
  uploaded: { label: "Queued", dot: "bg-graphite/50", text: "text-graphite" },
  processing: { label: "Indexing", dot: "bg-amber-500", text: "text-amber-800" },
  indexed: { label: "Ready", dot: "bg-emerald-600", text: "text-emerald-800" },
  failed: { label: "Failed", dot: "bg-red-600", text: "text-red-700" },
};

export function Status({ status, compact }: { status: DocStatus; compact?: boolean }) {
  const s = statusText[status];
  const pulsing = status === "processing" || status === "uploaded";
  return (
    <span className={cx("inline-flex items-center", compact ? "gap-1.5 text-xs" : "gap-2 text-sm", s.text)}>
      <span className="relative flex size-2">
        {pulsing && <span className={cx("absolute inline-flex size-full animate-ping rounded-full opacity-60", s.dot)} />}
        <span className={cx("relative inline-flex size-2 rounded-full", s.dot)} />
      </span>
      {s.label}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-rule/80", className)} aria-hidden />;
}

/** Native <dialog> for focus trap + Esc; motion only animates the panel. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} className="m-auto bg-transparent p-0 backdrop:backdrop-blur-[1px]">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            transition={spring}
            className="w-[min(92vw,400px)] rounded-xl bg-white p-6 text-ink shadow-[0_20px_60px_-15px_rgba(24,33,58,0.35)] ring-1 ring-rule"
          >
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-graphite">{body}</p>
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={onClose} autoFocus>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  onConfirm();
                  onClose();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </dialog>
  );
}

// ---------- Toasts ----------
type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}
const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4000);
  }, []);
  const bar = { success: "bg-emerald-600", error: "bg-red-600", info: "bg-bridge" };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-[380px]">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              role={t.kind === "error" ? "alert" : "status"}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
              transition={spring}
              className="pointer-events-auto flex w-full items-stretch overflow-hidden rounded-lg bg-ink text-sm text-white shadow-lg"
            >
              <span className={cx("w-1 shrink-0", bar[t.kind])} aria-hidden />
              <p className="flex-1 px-3.5 py-3 leading-snug">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="px-3 text-white/60 hover:text-white" aria-label="Dismiss notification">
                <X className="size-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
