// The one place that talks to the backend. Components never build URLs or call fetch themselves.
// Dev: requests go to /api and Vite proxies them to :8000. Production: set VITE_API_BASE_URL at build time.
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const ACCESS_KEY_STORAGE = "kb.accessKey";
const REQUEST_TIMEOUT_MS = 30_000;

export type DocStatus = "uploaded" | "processing" | "indexed" | "failed";

export interface DocumentRecord {
  id: string;
  filename: string;
  ext: string;
  size_bytes: number;
  status: DocStatus;
  error: string | null;
  uploaded_at: string;
  indexed_at: string | null;
  chunk_count: number;
  page_count: number | null;
  headings: string[];
}

export interface Citation {
  id: number;
  doc_id: string;
  filename: string;
  page: number | null;
  chunk_index: number;
  text: string;
  score: number | null; // null for passages picked for an overview rather than by similarity
}

export interface AppSettings {
  llm: {
    provider: "gemini" | "ollama";
    model: string;
    router_model: string | null;
    max_tokens: number;
    configured: boolean;
    ok: boolean;
    fallback: string | null;
    fallback_ready: boolean;
  };
  retrieval: {
    embedding_model: string;
    vector_store: string;
    chunk_size: number;
    chunk_overlap: number;
    top_k: number;
    min_similarity: number;
  };
  limits: { max_upload_mb: number; max_documents: number; max_question_chars: number; allowed_extensions: string[] };
  storage: { data_dir: string };
}

export type AnswerMode = "conversation" | "document" | "summary" | "no_evidence" | "no_documents";

export type ChatEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      mode: AnswerMode;
      citations: Citation[];
      grounded: boolean;
      retrieved: number;
      language?: string;
      search_query?: string;
      provider?: string;
      model?: string;
      fallback_reason?: string;
    }
  | { type: "error"; code: string; message: string };

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export const NETWORK_MSG = "Can't reach the KnowledgeBridge server. Check that the backend is running and that the app points at the right address.";

// ---------- access key (only used when the backend sets API_ACCESS_KEY) ----------
export const accessKey = {
  get: () => {
    try {
      return localStorage.getItem(ACCESS_KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  },
  set: (key: string) => {
    try {
      localStorage.setItem(ACCESS_KEY_STORAGE, key);
    } catch {
      /* storage unavailable: key lasts for this page only */
    }
  },
};

const headers = (extra: Record<string, string> = {}) => {
  const key = accessKey.get();
  return key ? { ...extra, "X-Access-Key": key } : extra;
};

function authRequired() {
  window.dispatchEvent(new Event("kb:access-required"));
}

async function errorFrom(res: Response): Promise<ApiError> {
  if (res.status === 401) authRequired();
  try {
    const body = await res.json();
    const msg = body?.detail?.message ?? (typeof body?.detail === "string" ? body.detail : null);
    if (msg) return new ApiError(msg, res.status);
  } catch {
    /* fall through */
  }
  // A proxy/gateway answers 502-504 itself when the backend is down.
  if ([502, 503, 504].includes(res.status)) return new ApiError(NETWORK_MSG, res.status);
  return new ApiError(res.status >= 500 ? "The server ran into a problem. Please try again." : `Request failed (${res.status}).`, res.status);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { ...init, headers: headers(init.headers as Record<string, string>), signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    if ((e as Error).name === "TimeoutError") throw new ApiError("The server took too long to respond. Please try again.");
    throw new ApiError(NETWORK_MSG);
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("The server sent an unexpected response.");
  }
}

export const api = {
  ready: () => request<{ status: string; llm_configured: boolean; access_key_required: boolean }>("/api/ready"),
  settings: () => request<AppSettings>("/api/settings"),
  documents: () => request<DocumentRecord[]>("/api/documents"),
  suggestions: (docIds: string[] | null) => request<string[]>(`/api/suggestions${docIds?.length ? `?doc_ids=${docIds.map(encodeURIComponent).join(",")}` : ""}`),
  deleteDocument: (id: string) => request<void>(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reindex: (id: string) => request<DocumentRecord>(`/api/documents/${encodeURIComponent(id)}/reindex`, { method: "POST" }),

  /** Upload with progress (fetch can't report upload progress, XHR can). Sends multipart/form-data with field "file". */
  upload(file: File, onProgress: (pct: number) => void): Promise<{ document: DocumentRecord; duplicate: boolean }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", BASE + "/api/documents");
      const key = accessKey.get();
      if (key) xhr.setRequestHeader("X-Access-Key", key);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onerror = () => reject(new ApiError(NETWORK_MSG));
      xhr.onload = () => {
        let body: any = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* handled below */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body?.document) return resolve(body);
        if (xhr.status === 401) authRequired();
        if (!body?.detail?.message && [0, 502, 503, 504].includes(xhr.status)) return reject(new ApiError(NETWORK_MSG, xhr.status));
        reject(new ApiError(body?.detail?.message ?? `Upload failed (${xhr.status}).`, xhr.status));
      };
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  /** Streams newline-delimited JSON events from /api/chat. */
  async chat(
    body: { question: string; history: { role: "user" | "assistant"; content: string }[]; doc_ids: string[] | null },
    onEvent: (e: ChatEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(BASE + "/api/chat", { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body), signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ApiError(NETWORK_MSG);
    }
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) throw new ApiError("The server sent an unexpected response.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    const handle = (line: string) => {
      if (!line.trim()) return;
      let event: ChatEvent;
      try {
        event = JSON.parse(line);
      } catch {
        throw new ApiError("The server sent a malformed response.");
      }
      if (!event || !["delta", "done", "error"].includes(event.type)) throw new ApiError("The server sent a malformed response.");
      if (event.type !== "delta") finished = true;
      onEvent(event);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(handle);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError" || e instanceof ApiError) throw e;
      throw new ApiError("The connection was interrupted while the answer was streaming.");
    }
    handle(buffer);
    if (!finished) throw new ApiError("The answer ended unexpectedly. Please try again.");
  },
};

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
