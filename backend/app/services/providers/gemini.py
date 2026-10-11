"""Google Gemini via the official google-genai SDK."""
import logging
import re
from collections.abc import AsyncIterator
from typing import TypeVar

from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pydantic import BaseModel, ValidationError

from ...core.config import Settings
from ..llm import LLMError, call_with_retries, stream_with_retries

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

QUOTA_MSG = (
    "The Gemini quota for this API key is used up (free-tier keys can be limited to a few requests per day). "
    "Answers will work again when the quota resets, or the server admin can enable billing or configure another provider."
)


def _error_details(exc: genai_errors.APIError) -> list[dict]:
    body = exc.details if isinstance(exc.details, dict) else {}
    return body.get("error", {}).get("details", []) or []


def _retry_after(exc: genai_errors.APIError) -> float | None:
    for d in _error_details(exc):
        if "RetryInfo" in d.get("@type", ""):
            m = re.match(r"([\d.]+)s", str(d.get("retryDelay", "")))
            if m:
                return float(m.group(1))
    return None


def _is_quota_exhausted(exc: genai_errors.APIError) -> bool:
    """Daily/total quota (won't recover within a retry window) vs. a short per-minute rate limit."""
    for d in _error_details(exc):
        if "QuotaFailure" in d.get("@type", ""):
            ids = " ".join(v.get("quotaId", "") for v in d.get("violations", []))
            if "PerDay" in ids or "PerMonth" in ids:
                return True
            if "PerMinute" in ids:
                return False
    msg = (exc.message or "").lower()
    return "exceeded your current quota" in msg and (_retry_after(exc) or 0) > 60


def to_llm_error(exc: Exception, model: str) -> LLMError:
    """Map provider/transport failures to messages that are safe to show users (no keys, no raw bodies)."""
    if isinstance(exc, genai_errors.APIError):
        code, msg = exc.code, (exc.message or "")
        if code in (401, 403) or (code == 400 and "api key" in msg.lower()):
            return LLMError("Gemini rejected the API key. Check GEMINI_API_KEY on the server.", "llm_auth")
        if code == 404:
            return LLMError(f"The configured Gemini model '{model}' was not found. Check the model settings.", "llm_model")
        if code == 429:
            if _is_quota_exhausted(exc):
                return LLMError(QUOTA_MSG, "llm_quota_exhausted")
            return LLMError("Gemini is receiving too many requests right now. Please try again shortly.", "llm_rate_limit", _retry_after(exc))
        if code in (408, 504):
            return LLMError("The language model took too long to respond. Please try again.", "llm_timeout")
        if 400 <= code < 500:
            log.warning("Gemini bad request: %s %s", code, exc.status)
            return LLMError("The language model rejected the request. Check the model settings in the server logs.", "llm_bad_request")
        log.warning("Gemini status error %s", code)
        return LLMError("The language model provider is having problems. Please try again shortly.", "llm_unavailable")
    name = type(exc).__name__
    if "Timeout" in name:
        return LLMError("The language model took too long to respond. Please try again.", "llm_timeout")
    if isinstance(exc, (OSError, ConnectionError)) or any(k in name for k in ("Connect", "Network", "Transport", "Protocol")):
        return LLMError("Could not reach the Gemini API. Check the server's network connection.", "llm_network")
    log.exception("Unexpected Gemini failure")
    return LLMError("Something went wrong while generating the answer.", "llm_unknown")


def _contents(messages: list[dict]) -> list[dict]:
    return [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]} for m in messages]


class GeminiClient:
    name = "gemini"

    def __init__(self, settings: Settings, client: genai.Client | None = None):
        self.settings = settings
        self.client = client or genai.Client(
            api_key=settings.gemini_api_key or "missing",
            http_options=genai_types.HttpOptions(
                timeout=int(settings.llm_timeout_seconds * 1000),
                # The SDK retries server-side hiccups only. 429s are handled in llm.py so that a used-up
                # daily quota fails fast instead of being retried (and spending more quota).
                retry_options=genai_types.HttpRetryOptions(attempts=3, initial_delay=1.0, max_delay=8.0, http_status_codes=[500, 502, 503, 504]),
            ),
        )

    async def check(self) -> tuple[bool, str]:
        # Never spends quota: only checks that a key is configured.
        return (True, f"key set, model {self.settings.llm_model}") if self.settings.gemini_api_key.strip() else (False, "GEMINI_API_KEY is not set")

    def stream(self, system: str, messages: list[dict], meta: dict | None = None) -> AsyncIterator[str]:
        if meta is not None:
            meta["provider"], meta["model"] = self.name, self.settings.llm_model
        return stream_with_retries(lambda: self._stream_once(system, messages), self.settings.llm_max_retries, self.name)

    async def _stream_once(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        model = self.settings.llm_model
        config = genai_types.GenerateContentConfig(system_instruction=system, max_output_tokens=self.settings.llm_max_tokens, temperature=0.3)
        try:
            chunks = await self.client.aio.models.generate_content_stream(model=model, contents=_contents(messages), config=config)
            last = None
            async for chunk in chunks:
                last = chunk
                if chunk.text:
                    yield chunk.text
        except LLMError:
            raise
        except Exception as exc:
            raise to_llm_error(exc, model) from exc
        if last is None:
            raise LLMError("The language model returned an empty response. Please try again.", "llm_empty")
        feedback = getattr(last, "prompt_feedback", None)
        finish = str(last.candidates[0].finish_reason) if last.candidates else ""
        if feedback and feedback.block_reason:
            yield "_The model declined to answer this request._"
        elif "SAFETY" in finish or "PROHIBITED" in finish:
            yield "\n\n_The model stopped because of its safety filters._"
        elif "MAX_TOKENS" in finish:
            yield "\n\n_The answer was cut off because it reached the length limit._"

    async def structured(self, system: str, prompt: str, schema: type[T]) -> T:
        model = self.settings.llm_router_model
        config = genai_types.GenerateContentConfig(
            system_instruction=system, temperature=0.0, max_output_tokens=1024, response_mime_type="application/json", response_schema=schema
        )

        async def once() -> T:
            try:
                res = await self.client.aio.models.generate_content(model=model, contents=prompt, config=config)
            except Exception as exc:
                raise to_llm_error(exc, model) from exc
            try:
                return res.parsed if isinstance(res.parsed, schema) else schema.model_validate_json(res.text or "")
            except (ValidationError, ValueError) as exc:
                log.warning("Malformed structured response from %s", model)
                raise LLMError("The language model returned a malformed response.", "llm_malformed") from exc

        return await call_with_retries(once, self.settings.llm_max_retries, self.name)
