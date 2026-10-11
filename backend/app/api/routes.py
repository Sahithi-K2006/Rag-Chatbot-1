"""HTTP routes. Thin layer: validate input, call services, shape responses."""
import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, File, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from ..core.config import ALLOWED_EXTENSIONS, Settings
from ..core.security import RateLimiter, api_error, require_access_key
from ..schemas import ChatRequest, DocumentRecord, UploadResponse
from ..services.answer_generation import ChatService
from ..services.document_processing import IngestError
from ..services.knowledge_base import DuplicateError, KnowledgeBase, StoreError

log = logging.getLogger(__name__)


def build_router(settings: Settings) -> APIRouter:
    public = APIRouter(prefix="/api")
    protected = APIRouter(prefix="/api", dependencies=[Depends(require_access_key(settings))])
    chat_limit = RateLimiter(settings.chat_requests_per_minute)
    upload_limit = RateLimiter(settings.uploads_per_minute)

    def kb(request: Request) -> KnowledgeBase:
        return request.app.state.kb

    def require_doc(request: Request, doc_id: str) -> DocumentRecord:
        doc = kb(request).get(doc_id)
        if doc is None:
            raise api_error(404, "not_found", "Document not found. It may already have been removed.")
        return doc

    # ---------- health ----------
    @public.get("/health")
    def health():
        """Liveness: the process is up."""
        return {"status": "ok"}

    @public.get("/ready")
    def ready(request: Request):
        """Readiness: storage and vector store are usable. LLM status is reported, not required."""
        try:
            kb(request).healthcheck()
        except Exception:
            log.exception("Readiness check failed")
            return JSONResponse(status_code=503, content={"status": "unavailable", "storage": False})
        llm = request.app.state.llm_status
        return {
            "status": "ready",
            "storage": True,
            "llm_configured": settings.llm_configured,
            "llm": {k: llm[k] for k in ("provider", "model", "ok", "detail", "fallback", "fallback_ready")},
            "access_key_required": bool(settings.api_access_key),
        }

    # ---------- configuration ----------
    @protected.get("/settings")
    def get_app_settings(request: Request):
        return {
            "llm": {
                "provider": settings.llm_provider,
                "model": settings.answer_model,
                "router_model": (settings.llm_router_model if settings.llm_provider == "gemini" else settings.ollama_router_model or settings.ollama_model) if settings.router_enabled else None,
                "max_tokens": settings.llm_max_tokens,
                "configured": settings.llm_configured,
                "ok": request.app.state.llm_status["ok"],
                "fallback": settings.llm_fallback_provider or None,
                "fallback_ready": request.app.state.llm_status["fallback_ready"],
            },
            "retrieval": {
                "embedding_model": settings.embedding_model,
                "vector_store": "ChromaDB (local, persistent)",
                "chunk_size": settings.chunk_size,
                "chunk_overlap": settings.chunk_overlap,
                "top_k": settings.top_k,
                "min_similarity": settings.min_similarity,
            },
            "limits": {
                "max_upload_mb": settings.max_upload_mb,
                "max_documents": settings.max_documents,
                "max_question_chars": settings.max_question_chars,
                "allowed_extensions": sorted(ALLOWED_EXTENSIONS),
            },
            "storage": {"data_dir": "backend/data (uploads, documents.json, chroma/)"},
        }

    # ---------- documents ----------
    @protected.get("/documents", response_model=list[DocumentRecord])
    def list_documents(request: Request):
        return kb(request).documents()

    @protected.get("/documents/{doc_id}", response_model=DocumentRecord)
    def get_document(request: Request, doc_id: str):
        return require_doc(request, doc_id)

    @protected.post("/documents", response_model=UploadResponse, status_code=202, dependencies=[Depends(upload_limit)])
    async def upload_document(request: Request, background: BackgroundTasks, file: UploadFile = File(...)):
        limit = settings.max_upload_mb * 1024 * 1024
        data = await file.read(limit + 1)  # never buffer more than the limit + 1 byte
        try:
            doc = kb(request).add_upload(file.filename or "", data)
        except DuplicateError as dup:
            return JSONResponse(status_code=200, content=UploadResponse(document=dup.existing, duplicate=True).model_dump())
        except IngestError as exc:
            status = 413 if "larger than" in str(exc) else 415 if "Unsupported" in str(exc) else 400
            raise api_error(status, "invalid_file", str(exc))
        background.add_task(kb(request).index, doc.id)
        return UploadResponse(document=doc)

    @protected.post("/documents/{doc_id}/reindex", response_model=DocumentRecord, status_code=202)
    def reindex_document(request: Request, background: BackgroundTasks, doc_id: str):
        doc = require_doc(request, doc_id)
        if doc.status == "processing":
            raise api_error(409, "busy", "This document is already being processed.")
        doc = kb(request).mark_for_reindex(doc_id)
        background.add_task(kb(request).index, doc_id)
        return doc

    @protected.delete("/documents/{doc_id}", status_code=204)
    def delete_document(request: Request, doc_id: str):
        require_doc(request, doc_id)
        try:
            kb(request).delete(doc_id)
        except StoreError as exc:
            raise api_error(500, "delete_failed", str(exc))

    @protected.get("/suggestions")
    def suggestions(request: Request, doc_ids: str | None = Query(None, description="Comma-separated document ids")) -> list[str]:
        """Optional prompts for the UI. They are only text to put in the input box; they never select an answer."""
        ids = kb(request).indexed_ids(doc_ids.split(",") if doc_ids else None)
        question_words = ("what", "how", "why", "when", "who", "where", "which", "note")
        out: list[str] = []
        for doc_id in ids:
            doc = kb(request).get(doc_id)
            name = doc.filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ")
            topics = [t for t in doc.headings[1:] if not t.lower().startswith(question_words)][:2]
            out.append(f"What does {doc.filename} cover?")
            out += [f"What does the {name} say about {t[0].lower() + t[1:]}?" for t in topics]
        return out[:6]

    # ---------- chat ----------
    @protected.post("/chat", dependencies=[Depends(chat_limit)])
    async def chat(request: Request, body: ChatRequest):
        question = body.question.strip()
        if not question:
            raise api_error(422, "empty_question", "Please enter a question.")
        if len(question) > settings.max_question_chars:
            raise api_error(422, "question_too_long", f"Questions are limited to {settings.max_question_chars} characters.")
        if body.doc_ids is not None and not kb(request).indexed_ids(body.doc_ids):
            raise api_error(422, "documents_not_ready", "The selected documents are not indexed. Pick a ready document or wait for indexing to finish.")
        service: ChatService = request.app.state.chat

        async def events():
            try:
                async for event in service.answer(question, body.history, body.doc_ids):
                    yield json.dumps(event, ensure_ascii=False) + "\n"
            except StoreError as exc:
                yield json.dumps({"type": "error", "code": "retrieval_failed", "message": str(exc)}) + "\n"

        return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    root = APIRouter()
    root.include_router(public)
    root.include_router(protected)
    return root
