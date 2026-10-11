"""FastAPI application factory: wiring, middleware, error handling."""
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.routes import build_router
from .core.config import Settings, get_settings
from .services.answer_generation import ChatService
from .services.embeddings import Embedder
from .services.knowledge_base import KnowledgeBase
from .services.llm import LLMClient, build_llm, startup_check

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("knowledgebridge")


def create_app(
    settings: Settings | None = None,
    embedder: Embedder | None = None,
    llm_factory: Callable[[Settings], LLMClient] = build_llm,
) -> FastAPI:
    settings = settings or get_settings()

    if settings.environment == "production" and not settings.api_access_key:
        raise RuntimeError("ENVIRONMENT=production requires API_ACCESS_KEY. Set it before exposing this server.")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Creates backend/data/{uploads,chroma} and the document registry on first start.
        app.state.kb = KnowledgeBase(settings, embedder)
        llm = llm_factory(settings)
        app.state.chat = ChatService(app.state.kb, settings, llm)
        # Provider diagnostics (no tokens spent): key present / Ollama reachable and model pulled.
        status = await startup_check(llm)
        app.state.llm_status = {**status, "configured": settings.llm_configured, "model": settings.answer_model}
        log.info(
            "Ready. data_dir=%s provider=%s model=%s provider_ok=%s (%s) fallback=%s ready=%s access_key=%s",
            settings.data_dir, settings.llm_provider, settings.answer_model, status["ok"], status["detail"],
            status["fallback"] or "none", status["fallback_ready"], "on" if settings.api_access_key else "off",
        )
        if not status["ok"]:
            log.warning("Primary LLM provider is not usable: %s. Chat answers will fail until this is fixed.", status["detail"])
        if not settings.api_access_key:
            log.warning("API_ACCESS_KEY is not set: anyone who can reach this server can upload, read and delete documents.")
        yield

    app = FastAPI(title="KnowledgeBridge AI", version="2.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "X-Access-Key"],
    )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        msg = f"Invalid request: {where} {first.get('msg', '')}".strip()
        return JSONResponse(status_code=422, content={"detail": {"code": "invalid_request", "message": msg}})

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.exception("Unhandled error")
        return JSONResponse(status_code=500, content={"detail": {"code": "internal", "message": "An unexpected server error occurred."}})

    app.include_router(build_router(settings))
    return app


app = create_app()
