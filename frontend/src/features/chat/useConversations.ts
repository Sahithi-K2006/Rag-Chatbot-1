import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, NETWORK_MSG, type AnswerMode, type Citation } from "../../services/api";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error";
  citations?: Citation[];
  grounded?: boolean;
  mode?: AnswerMode;
  error?: string;
  errorCode?: string;
  provider?: string;
  fallbackReason?: string;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  /** Documents this chat answers from. null = every ready document. */
  docIds: string[] | null;
  messages: Message[];
}

const STORAGE = "kb.conversations";
const MAX_SAVED = 30;
const DRAFT = "draft";

// ponytail: conversations live in this browser's localStorage; move to the backend if users need them across devices.
function loadSaved(): Conversation[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? "[]") as Conversation[];
    return raw.map((c) => ({
      ...c,
      messages: c.messages.map((m) => (m.status === "streaming" ? { ...m, status: "error" as const, error: "Interrupted by a page reload." } : m)),
    }));
  } catch {
    return [];
  }
}

export function useConversations() {
  const [saved, setSaved] = useState<Conversation[]>(loadSaved);
  const [activeId, setActiveId] = useState<string>(DRAFT);
  const [draftScope, setDraftScope] = useState<string[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(saved.slice(0, MAX_SAVED)));
    } catch {
      /* storage full or unavailable: history just won't survive reloads */
    }
  }, [saved]);

  const active: Conversation = saved.find((c) => c.id === activeId) ?? { id: DRAFT, title: "New chat", updatedAt: Date.now(), docIds: draftScope, messages: [] };

  const update = (id: string, fn: (c: Conversation) => Conversation) => setSaved((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
  const patchMessage = (convId: string, msgId: string, fn: (m: Message) => Message) =>
    update(convId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) }));

  const ask = useCallback(
    async (raw: string, conv: Conversation = active) => {
      const question = raw.trim();
      if (!question || abortRef.current) return; // ignore empty and repeated submissions
      const history = conv.messages.filter((m) => m.status === "done").map((m) => ({ role: m.role, content: m.content }));
      const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: question, status: "done" };
      const botMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "", status: "streaming" };

      let convId = conv.id;
      if (convId === DRAFT) {
        convId = crypto.randomUUID();
        const created: Conversation = { id: convId, title: question.slice(0, 60), updatedAt: Date.now(), docIds: conv.docIds, messages: [userMsg, botMsg] };
        setSaved((cs) => [created, ...cs]);
        setActiveId(convId);
      } else {
        update(convId, (c) => ({ ...c, updatedAt: Date.now(), messages: [...c.messages, userMsg, botMsg] }));
      }

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setPending(true);
      try {
        await api.chat(
          { question, history, doc_ids: conv.docIds },
          (e) => {
            if (e.type === "delta") patchMessage(convId, botMsg.id, (m) => ({ ...m, content: m.content + e.text }));
            else if (e.type === "done")
              patchMessage(convId, botMsg.id, (m) => ({
                ...m,
                status: "done",
                citations: e.citations,
                grounded: e.grounded,
                mode: e.mode,
                provider: e.provider,
                fallbackReason: e.fallback_reason,
              }));
            else patchMessage(convId, botMsg.id, (m) => ({ ...m, status: "error", error: e.message, errorCode: e.code }));
          },
          ctrl.signal,
        );
      } catch (e) {
        const aborted = (e as Error).name === "AbortError";
        const msg = aborted ? "Stopped." : e instanceof ApiError ? e.message : "Something went wrong.";
        const code = aborted ? "stopped" : msg === NETWORK_MSG ? "network" : "request_failed";
        patchMessage(convId, botMsg.id, (m) => (m.status === "streaming" ? { ...m, status: "error", error: msg, errorCode: code } : m));
      } finally {
        abortRef.current = null;
        setPending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active],
  );

  /** Re-ask a failed question: drop the failed pair, then ask again in the same chat. */
  const retry = (userMsgId: string) => {
    const i = active.messages.findIndex((m) => m.id === userMsgId);
    if (i < 0 || abortRef.current) return;
    const question = active.messages[i].content;
    const trimmed = { ...active, messages: active.messages.filter((_, j) => j !== i && j !== i + 1) };
    update(active.id, () => trimmed);
    ask(question, trimmed);
  };

  const setScope = (docIds: string[] | null) => {
    if (active.id === DRAFT) setDraftScope(docIds);
    else update(active.id, (c) => ({ ...c, docIds }));
  };

  const stop = () => abortRef.current?.abort();
  const newChat = (docIds: string[] | null = active.docIds) => {
    stop();
    setDraftScope(docIds);
    setActiveId(DRAFT);
  };
  const select = (id: string) => {
    stop();
    setActiveId(id);
  };
  const remove = (id: string) => {
    setSaved((cs) => cs.filter((c) => c.id !== id));
    if (id === activeId) setActiveId(DRAFT);
  };
  /** A deleted document can no longer be searched; drop it from every chat's scope. */
  const forgetDocument = (docId: string) => {
    const strip = (ids: string[] | null) => (ids ? (ids.filter((i) => i !== docId).length ? ids.filter((i) => i !== docId) : null) : null);
    setSaved((cs) => cs.map((c) => ({ ...c, docIds: strip(c.docIds) })));
    setDraftScope((s) => strip(s));
  };

  const conversations = [...saved].sort((a, b) => b.updatedAt - a.updatedAt);
  return { conversations, active, ask, retry, stop, pending, setScope, newChat, select, remove, forgetDocument };
}

export type Conversations = ReturnType<typeof useConversations>;
