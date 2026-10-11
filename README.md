# KnowledgeBridge AI

Upload your own PDF, TXT or Markdown documents and chat with an assistant that answers from them, with citations to the exact passages it used. It understands English, Telugu and mixed Telugu-English, informal wording and typos. It replies naturally to greetings, and when your documents don't cover a question it says so instead of guessing.

```
upload → validate → extract text (per page) → overlapping chunks → embeddings (Sentence Transformers)
       → ChromaDB index → [chat] understand message (Gemini router) → scoped similarity search
       → relevance gate → Gemini answer from the passages → citations to the passages actually used
```

| Layer | Tech (pinned) |
|---|---|
| Frontend | React 19.3, TypeScript 6.0, Tailwind CSS 4.3, Vite 8.3, Motion 14, lucide-react |
| Backend | Python 3.11+ (tested on 3.13), FastAPI 0.143, Pydantic 2.14, pydantic-settings 2.15 |
| RAG | sentence-transformers 6.1 (`all-MiniLM-L6-v2`), ChromaDB 1.5 (persistent), pypdf 6.20 |
| LLM | Google Gemini via `google-genai` 2.29: `gemini-2.5-flash` answers, `gemini-2.5-flash-lite` routes |

Architecture: [docs/architecture.md](docs/architecture.md). Deployment: [docs/deployment.md](docs/deployment.md).

> **Demo scope:** one shared knowledge base per deployment, with no user accounts. Set `API_ACCESS_KEY` before anyone else can reach the server; anyone with the key can read and delete all documents.

---

## Run locally

Needs Python 3.11+ and Node 20+.

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env            # then put your key in GEMINI_API_KEY (https://aistudio.google.com/apikey)
.venv/bin/uvicorn app.main:app --port 8000
```

```bash
cd frontend
npm install
npm run dev                     # http://localhost:5173 (proxies /api to :8000)
```

The first upload downloads the embedding model (about 90 MB), so it takes 10–30 seconds; later uploads take a second or two. A key exported in your shell overrides `backend/.env`.

## Using it

1. Click the **paperclip** in the message box (or drag a file onto the chat, or use **+** next to "Answer from" in the sidebar). The chat switches to answering from that file.
2. The chip above the input shows what the chat answers from and a spinner while indexing. Sending is enabled once the file is ready.
3. Ask anything. Each answer shows **Sources**; open one to read the exact passage, with your question's key words highlighted.
4. Under **Answer from** in the sidebar, choose *All documents* or a single document for the current chat. **New chat** starts fresh; **Recent chats** are kept in this browser.
5. **Manage documents** lists every file with its status (Queued, Indexing, Ready, Failed), the error for failed files, Re-index, Remove, and "chat about this".

Suggested questions only fill the input box; you still decide what to send. Answers always come from the text you send.

## Configuration (`backend/.env`)

All settings are listed with comments in [`backend/.env.example`](backend/.env.example). The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | – | Required for answers. Server-side only. |
| `LLM_MODEL` / `LLM_ROUTER_MODEL` | `gemini-2.5-flash` / `gemini-2.5-flash-lite` | Answer model and message-understanding model. Set the router empty to save quota (one call per message, weaker on Telugu, typos and follow-ups). |
| `API_ACCESS_KEY` | empty | When set, every `/api` route except health/ready requires header `X-Access-Key`; the UI asks for it. |
| `ENVIRONMENT` | `development` | `production` refuses to start without `API_ACCESS_KEY`. |
| `CORS_ORIGINS` | localhost:5173 | Comma-separated frontend origins. |
| `MIN_SIMILARITY` / `CONTEXT_MIN_SIMILARITY` | `0.30` / `0.20` | The best passage must reach the first value or the answer is "not found in your documents"; nearby passages down to the second are added as context. |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` / `TOP_K` | `700` / `120` / `5` | Chunking and retrieval. Re-index after changing chunking. |
| `MAX_UPLOAD_MB` / `MAX_DOCUMENTS` / `CHAT_REQUESTS_PER_MINUTE` | `10` / `200` / `20` | Limits. |
| `DATA_DIR` | `backend/data` | Uploads, registry and Chroma index. Must be persistent in production. |

**Gemini quota:** free-tier keys can be capped at **20 requests per day per model**. Each chat message uses two calls (router + answer), except greetings, which need only the router. When the quota runs out, the app shows "Gemini is rate-limited or out of quota" instead of an answer. Enable billing in Google AI Studio for real use.

## API

Errors always use the shape `{"detail": {"code", "message"}}`. Interactive docs are at `http://localhost:8000/docs`.

| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | Liveness. Public. |
| GET | `/api/ready` | Storage and vector-store check, plus `llm_configured` and `access_key_required`. Public. |
| GET | `/api/settings` | Non-secret configuration. |
| GET | `/api/documents` · `/api/documents/{id}` | Status: `uploaded`, `processing`, `indexed` or `failed` (with `error`). |
| POST | `/api/documents` | multipart `file`. Returns `202` and indexes in the background. Identical content returns `200` with `duplicate: true`. Other responses: `415` unsupported type, `413` too large, `400` invalid. |
| POST | `/api/documents/{id}/reindex` | `202`, or `409` if already processing. |
| DELETE | `/api/documents/{id}` | `204`. Removes the file, the registry entry and its vectors. |
| GET | `/api/suggestions?doc_ids=a,b` | Optional prompts for the UI. |
| POST | `/api/chat` | `{question, history, doc_ids \| null}` returns NDJSON events (below). Returns `422` if the selected documents aren't ready. |

```json
{"type":"delta","text":"You can return it within 21 days [1]."}
{"type":"done","mode":"document","grounded":true,"retrieved":5,"language":"en","search_query":"return rules",
 "intent":"document","documents_in_scope":1,
 "citations":[{"id":1,"doc_id":"…","filename":"policy.pdf","page":1,"chunk_index":0,"text":"…","score":0.48}]}
{"type":"error","code":"llm_rate_limit","message":"…"}
```

`mode` is one of `conversation`, `document`, `summary`, `no_evidence` or `no_documents`. Summary citations have `score: null`, because their passages are picked to represent the document rather than by similarity.

## How answers stay grounded

- **Message understanding.** A small model labels each message as smalltalk, summary, document or general. It detects the language (`en`, `te`, or `te-Latn` for Telugu-English mixes) and rewrites the message into a standalone English search query, which fixes typos, translates Telugu and resolves follow-ups. A rule-based fallback runs when that call fails. A word-list guard catches Telugu-English that the model mislabels as English.
- **Scoped retrieval.** Search runs only over the chat's selected documents, using both the rewrite and the original text.
- **Relevance gate.** If nothing is relevant enough, the user gets an honest "not found in your documents" in their language, and the answer model is never called.
- **Prompt.** Passages are treated as untrusted data (injection-resistant; closing tags inside documents are neutralized). Every fact must be cited, conflicts must be explained, and missing information must be stated.
- **Citations.** Only `[n]` markers that point to passages actually sent to the model become sources.

## Tests

```bash
cd backend
.venv/bin/python -m pytest -q -m "not llm"                                 # 73 tests: unit, API, real embeddings + Chroma
RUN_LLM_INTEGRATION=1 .venv/bin/python -m pytest -q -m llm                 # real Gemini calls (~8 requests)
.venv/bin/python -m eval.run_eval                                          # retrieval eval on sample_docs
.venv/bin/python -m eval.run_eval --llm --pause 15                         # + answers (spaced for free-tier limits)
cd ../frontend && npm run build                                            # type-check + production build
```

Coverage:
- **Ingestion:** validation and extraction (PDF pages, text, Markdown, empty, corrupt, scanned), chunking and metadata, duplicates, failures.
- **Regressions:** the Document A / Document B swap, including a question outside any suggestion list; changing a document changes the evidence; no cross-document contamination when a document is selected.
- **Conversation:** greetings with no documents; Telugu and mixed questions retrieving English passages through the rewrite; the localized "not found"; summaries; follow-ups; router failure fallback; the language guard.
- **Security:** access key, rate limits, production guard.
- **Model errors:** every model error code (401/403/404/429/5xx/timeout/network) mapped from real `google-genai` errors; CORS parsing.

Unit tests use a fake LLM and a fake embedder; the `llm` marker is the only suite that calls Gemini.

## Data and privacy

- Files are stored under `DATA_DIR` with generated names: `uploads/`, `documents.json`, `chroma/`. Delete documents in the UI, or stop the backend and delete the folder to erase everything.
- Each question sends Gemini your message, the last few chat turns and the matching passages, never whole documents.
- Uploaded files are never executed. Each is checked for type and size, and its content is sniffed: PDF magic bytes, and no binary text. Reads are capped at the size limit. Logs contain counts and scores only.
- Chats are stored in the browser's localStorage.

Sample documents in `backend/sample_docs/` describe fictional companies, and the eval uses them in a temporary index. They are **not** loaded into your knowledge base.

## Project layout

```
backend/app/
  main.py                    app factory, CORS, errors
  api/routes.py              HTTP routes
  core/config.py, security.py
  schemas.py
  services/document_processing.py, embeddings.py, knowledge_base.py,
           llm.py, conversation.py, answer_generation.py
backend/tests/  backend/eval/  backend/sample_docs/  backend/scripts/
frontend/src/
  services/api.ts            the only backend client
  hooks/useDocuments.ts
  features/chat/             ChatView, MessageBubble, useConversations
  features/documents/        DocumentsPage, useUploads
  features/settings/
  components/                Sidebar, ui, Answer
docs/  render.yaml
```
