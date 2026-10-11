"""Application settings, loaded from environment variables / backend/.env."""
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    # ---- Language model provider (all calls happen server-side) ----
    # "gemini" (hosted, needs GEMINI_API_KEY) or "ollama" (local/self-hosted models).
    llm_provider: Literal["gemini", "ollama"] = "gemini"
    # Optional second provider, used only if it passes the startup check and the primary fails before
    # producing any text (quota, rate limit, outage, timeout, network). Empty = no fallback.
    llm_fallback_provider: Literal["", "gemini", "ollama"] = ""
    llm_timeout_seconds: float = Field(60.0, gt=0)  # Gemini request timeout
    llm_max_retries: int = Field(2, ge=0, le=5)  # transient errors only; quota exhaustion is never retried
    llm_max_tokens: int = Field(8192, ge=256, le=65536)  # Gemini counts thinking tokens here too
    # Classify each message and rewrite it into a standalone English search query (one extra small call).
    llm_router_enabled: bool = True

    # Gemini. The key is only ever read server-side.
    gemini_api_key: str = ""
    llm_model: str = "gemini-2.5-flash"  # answers
    llm_router_model: str = "gemini-2.5-flash-lite"  # message understanding; "" disables the router for Gemini

    # Ollama (https://ollama.com). Local-only unless Ollama runs on infrastructure the backend can reach.
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = ""  # e.g. "gemma4:latest", "llama3.1:8b"; must be pulled first
    ollama_router_model: str = ""  # defaults to ollama_model
    ollama_timeout_seconds: float = Field(180.0, gt=0)  # first request may load the model from disk
    ollama_think: bool = False  # let reasoning models "think" (much slower locally)

    # Embeddings + retrieval
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_device: str = "cpu"  # "cuda" / "mps" if available; cpu is plenty for MiniLM
    chunk_size: int = Field(700, ge=200, le=4000)  # characters; smaller chunks keep sections from mixing
    chunk_overlap: int = Field(120, ge=0, le=1000)
    top_k: int = Field(5, ge=1, le=20)
    # Two-level gate (cosine similarity 0..1). The best passage must reach min_similarity, otherwise the
    # documents don't cover the question and the model is not asked. Once it does, other top-k passages
    # down to context_min_similarity are added as context; only passages the answer cites are shown.
    min_similarity: float = Field(0.30, ge=0.0, le=1.0)
    context_min_similarity: float = Field(0.20, ge=0.0, le=1.0)
    # Passages sampled per document for "what is this document about?" questions.
    summary_chunks: int = Field(8, ge=2, le=30)

    # Storage + limits
    data_dir: Path = BACKEND_DIR / "data"
    max_upload_mb: int = Field(10, ge=1, le=100)
    max_documents: int = Field(200, ge=1)
    max_question_chars: int = Field(2000, ge=10)
    chat_requests_per_minute: int = Field(20, ge=1)  # per client IP
    uploads_per_minute: int = Field(10, ge=1)  # per client IP

    # "production" refuses to start without API_ACCESS_KEY, so a public deployment can't be left open.
    environment: str = Field("development", pattern="^(development|production)$")
    # Access control: when set, every /api route except health/ready requires header X-Access-Key.
    # Set this for any deployment reachable by people other than you.
    api_access_key: str = ""
    # Comma-separated or JSON list, e.g. https://kb.example.com,http://localhost:5173
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                import json

                return json.loads(v)
            return [o.strip().rstrip("/") for o in v.split(",") if o.strip()]
        return v

    @model_validator(mode="after")
    def _check_providers(self):
        if self.llm_fallback_provider == self.llm_provider:
            raise ValueError("LLM_FALLBACK_PROVIDER must differ from LLM_PROVIDER")
        if "ollama" in (self.llm_provider, self.llm_fallback_provider) and not self.ollama_model.strip():
            raise ValueError("OLLAMA_MODEL is required when Ollama is the provider or fallback")
        return self

    def provider_configured(self, name: str) -> bool:
        if name == "gemini":
            return bool(self.gemini_api_key.strip())
        if name == "ollama":
            return bool(self.ollama_model.strip() and self.ollama_base_url.strip())
        return False

    @property
    def llm_configured(self) -> bool:
        return self.provider_configured(self.llm_provider)

    @property
    def router_enabled(self) -> bool:
        if not self.llm_router_enabled:
            return False
        return bool(self.llm_router_model) if self.llm_provider == "gemini" else True

    @property
    def answer_model(self) -> str:
        return self.llm_model if self.llm_provider == "gemini" else self.ollama_model


ALLOWED_EXTENSIONS = {".pdf": "PDF", ".txt": "Plain text", ".md": "Markdown", ".markdown": "Markdown"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
