# Architecture

KnowledgeBridge AI is a single-tenant retrieval-augmented generation (RAG) assistant: a React SPA talking to a FastAPI backend that owns the documents, the vector index and every model call.

```
Browser (React + Vite)                       FastAPI backend
──────────────────────                       ─────────────────────────────────────────────────────────
services/api.ts  ── multipart upload ──▶  api/routes.py  POST /api/documents
                                              └▶ services/knowledge_base.add_upload  (validate, sha256 dedupe,
                                                 save as data/uploads/<uuid>.<ext>, status=uploaded)
                                              └▶ background: knowledge_base.index
                                                   document_processing.extract_pages   (pypdf / text)
                                                   document_processing.chunk_pages     (overlapping, per page)
                                                   embeddings.sentence_transformer_embedder
                                                   ChromaDB add (doc_id, filename, page, chunk_index)
                                                   status=indexed only after Chroma accepts the chunks
                ◀── poll GET /api/documents (status: uploaded → processing → indexed | failed)

                 ── POST /api/chat ──────▶  services/answer_generation.ChatService.answer
                    {question, history,         1. conversation.plan_message   (router model, JSON)
                     doc_ids | null}               intent: smalltalk | summary | document | general
                                                   language: en | te | te-Latn | …
                                                   search_query: standalone English rewrite
                                                2. smalltalk → model-written reply, no retrieval
                                                   summary   → knowledge_base.overview(doc_ids)
                                                   otherwise → knowledge_base.search([rewrite, original], doc_ids)
                                                3. gate: best score < MIN_SIMILARITY → honest "not found"
                                                   (localized, model not called)
                                                4. llm.GeminiClient.stream(ANSWER_PROMPT, history + sources)
                                                5. map_citations: only [n] that point at sent passages
                ◀── NDJSON stream: delta… then done{mode, citations, grounded, language, search_query}
```

## Backend layout (`backend/app`)

| Module | Responsibility |
|---|---|
| `main.py` | App factory: settings, CORS, error handlers, lifespan (creates the knowledge base and chat service). |
| `api/routes.py` | HTTP layer only: input checks, status codes, streaming response. |
| `core/config.py` | All configuration from environment variables / `backend/.env`. |
| `core/security.py` | Optional shared access key (`X-Access-Key`) and per-IP rate limits. |
| `schemas.py` | Request/response models shared by routes and services. |
| `services/document_processing.py` | Upload validation, text extraction, chunking. Pure functions. |
| `services/embeddings.py` | Embedding model wrapper (Sentence Transformers, lazily loaded, serialized). |
| `services/knowledge_base.py` | Document registry (`documents.json`) and ChromaDB: index, delete, scoped search, overview. |
| `services/llm.py` | Gemini client: streaming, structured JSON, error mapping. The only provider-specific code. |
| `services/conversation.py` | Message understanding (router prompt + rule-based fallback, language guard). |
| `services/answer_generation.py` | Prompts, retrieval gate, citation mapping, chat orchestration. |

## Frontend layout (`frontend/src`)

| Path | Responsibility |
|---|---|
| `services/api.ts` | The only module that calls the backend. Base URL, access-key header, timeouts, NDJSON parsing, explicit connection errors. |
| `hooks/useDocuments.ts` | Document list with polling while indexing. |
| `features/documents/useUploads.ts` | Client-side validation, upload progress, indexing-complete notifications. Shared by the composer, sidebar and documents page. |
| `features/chat/useConversations.ts` | Conversations (saved in localStorage), per-chat document scope, streaming, retry, stop. |
| `features/chat/ChatView.tsx`, `MessageBubble.tsx` | Chat screen, composer with attach/drag-and-drop, message bubbles, expandable source cards. |
| `features/documents/DocumentsPage.tsx` | Manage documents: status filters, re-index, remove, "chat about this". |
| `features/settings/SettingsPage.tsx` | Read-only configuration and setup help. |
| `components/` | Sidebar, UI primitives, Markdown answer renderer with clickable citations. |

## Data and persistence

Everything the backend stores lives under `DATA_DIR` (default `backend/data`):

- `uploads/<uuid>.<ext>`: original files, named by generated id (never the user's filename)
- `documents.json`: registry (status, errors, counts), written atomically
- `chroma/`: ChromaDB persistent index (cosine space)

On startup, documents left in `uploaded`/`processing` (server stopped mid-index) are marked `failed` with a "re-index" message. Conversations are stored only in the browser's localStorage.

## Grounding guarantees (enforced in code)

1. Document questions always run vector search, restricted to the chat's selected documents (`doc_ids`, `$in` filter).
2. If the best passage scores below `MIN_SIMILARITY`, the model is not asked; the user gets a localized "not found in your documents" reply.
3. Retrieved text is wrapped in `<source>` tags (closing tags in documents are neutralized) and the prompt treats it as untrusted data.
4. Only citation markers that refer to passages actually sent are returned; others are dropped and logged.
5. Logs record intents, counts and scores, never document text, prompts or keys.

## Known limits

- Single tenant: one knowledge base per deployment. The access key is a shared secret, not per-user auth.
- One process: rate limits, locks and the index are per-process (`--workers 1`, one instance).
- No OCR: image-only PDFs fail with an explanation.
- English embedding model (`all-MiniLM-L6-v2`); Telugu and mixed questions work through the router's English rewrite. Without the router (quota exhausted or disabled), Telugu-script questions retrieve poorly; a multilingual embedding model such as `intfloat/multilingual-e5-small` would remove that dependency (re-index required).
