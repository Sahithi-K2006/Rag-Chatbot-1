"""Language-model provider layer.

The rest of the app only sees `LLMClient` and `LLMError`. Provider specifics live in
`services/providers/` (Gemini, Ollama). This module adds the shared pieces: user-safe error codes,
a bounded retry policy, and an optional fallback provider that is only used when it was explicitly
configured and passed its startup check.
"""
import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Protocol, TypeVar

from pydantic import BaseModel

from ..core.config import Settings

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# Codes that mean "this provider can't answer right now" (worth trying a configured fallback).
UNAVAILABLE_CODES = {"llm_quota_exhausted", "llm_rate_limit", "llm_unavailable", "llm_timeout", "llm_network", "llm_auth", "llm_model"}
# Codes worth retrying on the same provider, with backoff.
RETRYABLE_CODES = {"llm_rate_limit", "llm_unavailable", "llm_timeout", "llm_network"}
MAX_RETRY_WAIT_SECONDS = 12.0


class LLMError(Exception):
    """Message is safe to show to users. `retry_after` is seconds suggested by the provider, if any."""

    def __init__(self, message: str, code: str, retry_after: float | None = None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


class LLMClient(Protocol):
    name: str

    def stream(self, system: str, messages: list[dict], meta: dict | None = None) -> AsyncIterator[str]:
        """Stream answer text. Implementations record the provider that answered in meta["provider"]."""
        ...

    async def structured(self, system: str, prompt: str, schema: type[T]) -> T:
        """One small non-streamed call that must return JSON matching `schema`."""
        ...


def retry_delay(exc: LLMError, attempt: int) -> float | None:
    """Seconds to wait before retrying, or None if this error must not be retried.
    Quota exhaustion, bad keys, unknown models and bad requests are never retried."""
    if exc.code not in RETRYABLE_CODES:
        return None
    delay = exc.retry_after if exc.retry_after is not None else min(1.0 * 2**attempt, 8.0)
    return None if delay > MAX_RETRY_WAIT_SECONDS else delay


async def call_with_retries(fn: Callable[[], Awaitable[T]], max_retries: int, provider: str) -> T:
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except LLMError as exc:
            delay = retry_delay(exc, attempt) if attempt < max_retries else None
            if delay is None:
                raise
            log.info("%s %s; retrying in %.1fs (attempt %d/%d)", provider, exc.code, delay, attempt + 1, max_retries)
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")


async def stream_with_retries(open_stream: Callable[[], AsyncIterator[str]], max_retries: int, provider: str) -> AsyncIterator[str]:
    """Retries only while nothing has been yielded yet, so the user never sees duplicated text."""
    for attempt in range(max_retries + 1):
        started = False
        try:
            async for text in open_stream():
                started = True
                yield text
            return
        except LLMError as exc:
            delay = retry_delay(exc, attempt) if (attempt < max_retries and not started) else None
            if delay is None:
                raise
            log.info("%s %s before first token; retrying in %.1fs (attempt %d/%d)", provider, exc.code, delay, attempt + 1, max_retries)
            await asyncio.sleep(delay)


class FallbackClient:
    """Primary provider with an explicitly configured secondary. Switches only when the primary fails
    before producing any text, and only if the secondary passed its startup check."""

    def __init__(self, primary: LLMClient, secondary: LLMClient):
        self.primary, self.secondary = primary, secondary
        self.name = primary.name
        self.fallback_ready = False  # set by startup_check

    async def startup_check(self) -> dict:
        primary = await _check(self.primary)
        secondary = await _check(self.secondary)
        self.fallback_ready = secondary["ok"]
        if not self.fallback_ready:
            log.warning("Fallback provider %s is configured but not usable (%s); it will not be used.", self.secondary.name, secondary["detail"])
        return {**primary, "fallback": self.secondary.name, "fallback_ready": self.fallback_ready, "fallback_detail": secondary["detail"]}

    async def stream(self, system: str, messages: list[dict], meta: dict | None = None) -> AsyncIterator[str]:
        started = False
        try:
            async for text in self.primary.stream(system, messages, meta):
                started = True
                yield text
            return
        except LLMError as exc:
            if started or not self.fallback_ready or exc.code not in UNAVAILABLE_CODES:
                raise
            log.warning("Primary provider %s failed (%s); answering with fallback %s", self.primary.name, exc.code, self.secondary.name)
            if meta is not None:
                meta["fallback_reason"] = exc.code
        async for text in self.secondary.stream(system, messages, meta):
            yield text

    async def structured(self, system: str, prompt: str, schema: type[T]) -> T:
        # Routing is optional (conversation.py falls back to rules), so it never waits on the fallback
        # provider: a slow local model would otherwise roughly double the time to answer.
        return await self.primary.structured(system, prompt, schema)


async def _check(client: LLMClient) -> dict:
    check = getattr(client, "check", None)
    if check is None:
        return {"provider": client.name, "ok": True, "detail": "not checked"}
    ok, detail = await check()
    return {"provider": client.name, "ok": ok, "detail": detail}


async def startup_check(client: LLMClient) -> dict:
    """Diagnostics for logs and /api/ready. Never spends model quota."""
    if isinstance(client, FallbackClient):
        return await client.startup_check()
    return {**(await _check(client)), "fallback": None, "fallback_ready": False}


def make_provider(name: str, settings: Settings) -> LLMClient:
    if name == "gemini":
        from .providers.gemini import GeminiClient

        return GeminiClient(settings)
    if name == "ollama":
        from .providers.ollama import OllamaClient

        return OllamaClient(settings)
    raise ValueError(f"Unknown LLM provider {name!r}")


def build_llm(settings: Settings) -> LLMClient:
    primary = make_provider(settings.llm_provider, settings)
    if settings.llm_fallback_provider:
        return FallbackClient(primary, make_provider(settings.llm_fallback_provider, settings))
    return primary
