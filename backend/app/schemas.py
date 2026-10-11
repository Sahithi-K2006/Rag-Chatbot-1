"""Request/response models shared by the API and services."""
from typing import Literal

from pydantic import BaseModel, Field

from .services.knowledge_base import DocumentRecord  # noqa: F401  (re-exported for the API)


class HistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20000)


class ChatRequest(BaseModel):
    question: str = Field(max_length=20000)
    history: list[HistoryTurn] = Field(default_factory=list, max_length=50)
    # Documents to answer from. Omit or null = every indexed document in the knowledge base.
    doc_ids: list[str] | None = Field(default=None, max_length=200)


class Citation(BaseModel):
    id: int  # the [n] marker used in the answer
    doc_id: str
    filename: str
    page: int | None
    chunk_index: int
    text: str
    score: float | None


class UploadResponse(BaseModel):
    document: DocumentRecord
    duplicate: bool = False
