"""Document registry (JSON on disk) + ChromaDB vector index."""
import hashlib
import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Literal

import chromadb
from chromadb.config import Settings as ChromaSettings
from pydantic import BaseModel

from ..core.config import Settings
from .document_processing import IngestError, chunk_pages, extract_headings, extract_pages, validate_upload
from .embeddings import Embedder, sentence_transformer_embedder

log = logging.getLogger(__name__)

Status = Literal["uploaded", "processing", "indexed", "failed"]


class DocumentRecord(BaseModel):
    id: str
    filename: str
    ext: str
    size_bytes: int
    sha256: str
    status: Status
    error: str | None = None
    uploaded_at: str
    indexed_at: str | None = None
    chunk_count: int = 0
    page_count: int | None = None
    headings: list[str] = []


class Hit(BaseModel):
    doc_id: str
    filename: str
    page: int | None
    chunk_index: int
    text: str
    # Cosine similarity 0..1 (relevance, not proof of correctness). None for passages chosen
    # for a document overview rather than by similarity.
    score: float | None


class DuplicateError(Exception):
    def __init__(self, existing: DocumentRecord):
        self.existing = existing


class StoreError(Exception):
    """Vector store / embedding failure. Message is safe to show users."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class KnowledgeBase:
    def __init__(self, settings: Settings, embedder: Embedder | None = None):
        self.settings = settings
        self.embed = embedder or sentence_transformer_embedder(settings.embedding_model, settings.embedding_device)
        self.uploads = settings.data_dir / "uploads"
        self.uploads.mkdir(parents=True, exist_ok=True)
        self._registry_path = settings.data_dir / "documents.json"
        # ponytail: one process-wide lock; fine for a single-user demo, use a DB for concurrency.
        self._lock = threading.RLock()
        self._docs: dict[str, DocumentRecord] = self._load_registry()
        client = chromadb.PersistentClient(
            path=str(settings.data_dir / "chroma"), settings=ChromaSettings(anonymized_telemetry=False)
        )
        self.collection = client.get_or_create_collection(
            "knowledge_base", metadata={"hnsw:space": "cosine"}, embedding_function=None
        )
        # Anything mid-flight when the server stopped never finished indexing.
        for doc in self._docs.values():
            if doc.status in ("uploaded", "processing"):
                doc.status, doc.error = "failed", "Processing was interrupted. Re-index to try again."
        self._save_registry()

    # ---------- registry ----------
    def _load_registry(self) -> dict[str, DocumentRecord]:
        if not self._registry_path.exists():
            return {}
        raw = json.loads(self._registry_path.read_text("utf-8"))
        return {d["id"]: DocumentRecord(**d) for d in raw}

    def _save_registry(self) -> None:
        with self._lock:
            tmp = self._registry_path.with_suffix(".tmp")
            tmp.write_text(json.dumps([d.model_dump() for d in self._docs.values()], indent=2), "utf-8")
            tmp.replace(self._registry_path)

    def _update(self, doc_id: str, **fields) -> None:
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is None:  # deleted while processing
                return
            for k, v in fields.items():
                setattr(doc, k, v)
            self._save_registry()

    def documents(self) -> list[DocumentRecord]:
        with self._lock:
            return sorted(self._docs.values(), key=lambda d: d.uploaded_at, reverse=True)

    def get(self, doc_id: str) -> DocumentRecord | None:
        return self._docs.get(doc_id)

    # ---------- lifecycle ----------
    def add_upload(self, filename: str, data: bytes) -> DocumentRecord:
        ext = validate_upload(filename, data, self.settings.max_upload_mb * 1024 * 1024)
        digest = hashlib.sha256(data).hexdigest()
        with self._lock:
            existing = next((d for d in self._docs.values() if d.sha256 == digest), None)
            if existing:
                raise DuplicateError(existing)
            if len(self._docs) >= self.settings.max_documents:
                raise IngestError(f"The knowledge base is limited to {self.settings.max_documents} documents.")
            doc = DocumentRecord(
                id=uuid.uuid4().hex,
                filename=_safe_display_name(filename),
                ext=ext,
                size_bytes=len(data),
                sha256=digest,
                status="uploaded",
                uploaded_at=_now(),
            )
            # Stored under a generated id, never the user-supplied name.
            (self.uploads / f"{doc.id}{ext}").write_bytes(data)
            self._docs[doc.id] = doc
            self._save_registry()
        return doc

    def index(self, doc_id: str) -> None:
        """Extract → chunk → embed → upsert. Only marks 'indexed' after Chroma accepts the chunks."""
        doc = self.get(doc_id)
        if doc is None:
            return
        self._update(doc_id, status="processing", error=None)
        try:
            data = (self.uploads / f"{doc.id}{doc.ext}").read_bytes()
            pages = extract_pages(data, doc.ext)
            chunks = chunk_pages(pages, self.settings.chunk_size, self.settings.chunk_overlap)
            vectors = self.embed([c.text for c in chunks])
            with self._lock:
                if self.get(doc_id) is None:
                    return
                self.collection.delete(where={"doc_id": doc_id})
                self.collection.add(
                    ids=[f"{doc_id}:{c.index}" for c in chunks],
                    embeddings=vectors,
                    documents=[c.text for c in chunks],
                    metadatas=[
                        # Chroma metadata can't hold None, so "no page" is stored as 0.
                        {"doc_id": doc_id, "filename": doc.filename, "page": c.page or 0, "chunk_index": c.index}
                        for c in chunks
                    ],
                )
            self._update(
                doc_id,
                status="indexed",
                indexed_at=_now(),
                chunk_count=len(chunks),
                page_count=pages[-1].page if doc.ext == ".pdf" else None,
                headings=extract_headings(pages),
            )
            log.info("Indexed document %s (%d chunks)", doc_id, len(chunks))
        except IngestError as exc:
            log.info("Document %s rejected: %s", doc_id, exc)
            self._update(doc_id, status="failed", error=str(exc), chunk_count=0)
        except FileNotFoundError:
            self._update(doc_id, status="failed", error="The stored file is missing. Remove and upload it again.")
        except Exception:
            log.exception("Indexing failed for document %s", doc_id)
            self._update(
                doc_id,
                status="failed",
                chunk_count=0,
                error="Indexing failed while creating embeddings or writing to the vector database. Try re-indexing.",
            )

    def mark_for_reindex(self, doc_id: str) -> DocumentRecord:
        self._update(doc_id, status="processing", error=None)
        return self._docs[doc_id]

    def delete(self, doc_id: str) -> None:
        with self._lock:
            try:
                self.collection.delete(where={"doc_id": doc_id})
            except Exception as exc:
                log.exception("Vector delete failed for %s", doc_id)
                raise StoreError("The document could not be removed from the vector database.") from exc
            doc = self._docs.pop(doc_id)
            (self.uploads / f"{doc.id}{doc.ext}").unlink(missing_ok=True)
            self._save_registry()

    # ---------- retrieval ----------
    def indexed_ids(self, doc_ids: list[str] | None = None) -> list[str]:
        """Indexed documents in scope: all of them, or only the requested ones."""
        with self._lock:
            ready = [d.id for d in self._docs.values() if d.status == "indexed"]
        return ready if doc_ids is None else [i for i in ready if i in set(doc_ids)]

    def search(self, queries: str | list[str], k: int, doc_ids: list[str] | None = None) -> list[Hit]:
        """Similarity search restricted to `doc_ids` (None = whole knowledge base). Several phrasings of
        the same question can be passed; each chunk keeps its best score across them."""
        queries = [queries] if isinstance(queries, str) else [q for q in dict.fromkeys(queries) if q.strip()]
        scope = self.indexed_ids(doc_ids)
        if not scope or not queries:
            return []
        try:
            vectors = self.embed(queries)
            res = self.collection.query(
                query_embeddings=vectors,
                n_results=k,
                where={"doc_id": {"$in": scope}},
                include=["documents", "metadatas", "distances"],
            )
        except Exception as exc:
            log.exception("Vector search failed")
            raise StoreError("Searching the knowledge base failed. Please try again.") from exc
        best: dict[str, Hit] = {}
        for ids, texts, metas, dists in zip(res["ids"], res["documents"], res["metadatas"], res["distances"]):
            for cid, text, meta, dist in zip(ids, texts, metas, dists):
                hit = self._hit(meta, text, round(max(0.0, 1.0 - dist), 4))
                if hit and (cid not in best or hit.score > best[cid].score):
                    best[cid] = hit
        return sorted(best.values(), key=lambda h: h.score or 0, reverse=True)[:k]

    def overview(self, doc_ids: list[str] | None, per_doc: int, limit: int = 16) -> list[Hit]:
        """Evenly spaced passages from each document, for 'what is this about?' style questions
        that similarity search can't answer."""
        scope = self.indexed_ids(doc_ids)
        if not scope:
            return []
        per_doc = max(2, min(per_doc, limit // len(scope) or 2))
        try:
            res = self.collection.get(where={"doc_id": {"$in": scope}}, include=["documents", "metadatas"])
        except Exception as exc:
            log.exception("Vector get failed")
            raise StoreError("Reading the knowledge base failed. Please try again.") from exc
        by_doc: dict[str, list[tuple[dict, str]]] = {}
        for text, meta in zip(res["documents"], res["metadatas"]):
            by_doc.setdefault(meta["doc_id"], []).append((meta, text))
        out: list[Hit] = []
        for doc_id in scope:
            chunks = sorted(by_doc.get(doc_id, []), key=lambda mt: mt[0]["chunk_index"])
            step = max(1, len(chunks) / per_doc)
            picked = [chunks[int(i * step)] for i in range(min(per_doc, len(chunks)))]
            out += [h for meta, text in picked if (h := self._hit(meta, text, None))]
        return out[:limit]

    def _hit(self, meta: dict, text: str, score: float | None) -> Hit | None:
        doc = self.get(meta["doc_id"])
        if doc is None or doc.status != "indexed":
            return None
        return Hit(doc_id=doc.id, filename=doc.filename, page=meta["page"] or None, chunk_index=meta["chunk_index"], text=text, score=score)

    def healthcheck(self) -> None:
        """Raises if the vector store or data directory is unusable."""
        self.collection.count()
        probe = self.settings.data_dir / ".write-probe"
        probe.write_text("ok")
        probe.unlink()


def _safe_display_name(name: str) -> str:
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    return name[:200] or "untitled"
