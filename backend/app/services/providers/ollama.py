"""Ollama (local or self-hosted models) over its HTTP API.

Local-only unless you run Ollama on server infrastructure the backend can reach: a hosted backend
cannot use an Ollama instance running on a developer's laptop.
"""
import json
import logging
from collections.abc import AsyncIterator
from typing import TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from ...core.config import Settings
from ..llm import LLMError, call_with_retries, stream_with_retries

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)


class OllamaClient:
    name = "ollama"

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.base_url = settings.ollama_base_url.rstrip("/")
        # connect fast, but allow slow first tokens: loading a model from disk can take a minute.
        timeout = httpx.Timeout(settings.ollama_timeout_seconds, connect=5.0)
        self._client_kwargs = {"base_url": self.base_url, "timeout": timeout, "transport": transport}

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(**self._client_kwargs)

    @property
    def router_model(self) -> str:
        return self.settings.ollama_router_model or self.settings.ollama_model

    def _error(self, exc: Exception, model: str) -> LLMError:
        if isinstance(exc, LLMError):
            return exc
        if isinstance(exc, httpx.TimeoutException):
            return LLMError("The local model took too long to respond. It may still be loading; try again.", "llm_timeout")
        if isinstance(exc, httpx.TransportError):
            return LLMError(f"Can't reach Ollama at {self.base_url}. Is it running (`ollama serve`)?", "llm_network")
        log.exception("Unexpected Ollama failure")
        return LLMError("Something went wrong while generating the answer.", "llm_unknown")

    def _status_error(self, status: int, body: str, model: str) -> LLMError:
        try:
            detail = json.loads(body).get("error", "")
        except ValueError:
            detail = ""
        if status == 404 or "not found" in detail.lower():
            return LLMError(f"Ollama doesn't have the model '{model}'. Run `ollama pull {model}` on the server.", "llm_model")
        if status in (429, 503):
            return LLMError("The local model is busy. Please try again shortly.", "llm_unavailable")
        log.warning("Ollama status %s: %s", status, detail[:200])
        if 400 <= status < 500:
            return LLMError("The local model rejected the request. Check the Ollama settings in the server logs.", "llm_bad_request")
        return LLMError("The local model server returned an error. Please try again shortly.", "llm_unavailable")

    def _payload(self, model: str, messages: list[dict], stream: bool, **extra) -> dict:
        payload = {"model": model, "messages": messages, "stream": stream, "options": {"temperature": extra.pop("temperature", 0.3)}, **extra}
        if not self.settings.ollama_think:
            payload["think"] = False  # reasoning models are much slower locally; answers don't need it
        return payload

    async def check(self) -> tuple[bool, str]:
        """Server reachable and model pulled. Doesn't load the model or generate anything."""
        try:
            async with self._client() as client:
                res = await client.get("/api/tags", timeout=5.0)
                res.raise_for_status()
                names = {m.get("name") for m in res.json().get("models", [])} | {m.get("model") for m in res.json().get("models", [])}
        except Exception as exc:
            return False, f"Ollama not reachable at {self.base_url} ({type(exc).__name__})"
        wanted = self.settings.ollama_model
        if wanted not in names and f"{wanted}:latest" not in names:
            return False, f"model {wanted!r} not pulled (run `ollama pull {wanted}`)"
        return True, f"model {wanted} available at {self.base_url}"

    def stream(self, system: str, messages: list[dict], meta: dict | None = None) -> AsyncIterator[str]:
        model = self.settings.ollama_model
        if meta is not None:
            meta["provider"], meta["model"] = self.name, model
        msgs = [{"role": "system", "content": system}, *messages]
        return stream_with_retries(lambda: self._stream_once(model, msgs), self.settings.llm_max_retries, self.name)

    async def _stream_once(self, model: str, messages: list[dict]) -> AsyncIterator[str]:
        payload = self._payload(model, messages, stream=True)
        payload["options"]["num_predict"] = self.settings.llm_max_tokens
        produced = False
        try:
            async with self._client() as client, client.stream("POST", "/api/chat", json=payload) as res:
                if res.status_code >= 400:
                    raise self._status_error(res.status_code, (await res.aread()).decode(errors="replace"), model)
                async for line in res.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except ValueError as exc:
                        raise LLMError("The local model sent a malformed response.", "llm_malformed") from exc
                    if event.get("error"):
                        raise self._status_error(500, json.dumps(event), model)
                    text = (event.get("message") or {}).get("content", "")
                    if text:
                        produced = True
                        yield text
                    if event.get("done"):
                        if event.get("done_reason") == "length":
                            yield "\n\n_The answer was cut off because it reached the length limit._"
                        break
        except LLMError:
            raise
        except Exception as exc:
            raise self._error(exc, model) from exc
        if not produced:
            raise LLMError("The local model returned an empty response. Please try again.", "llm_empty")

    async def structured(self, system: str, prompt: str, schema: type[T]) -> T:
        model = self.router_model
        payload = self._payload(model, [{"role": "system", "content": system}, {"role": "user", "content": prompt}], stream=False, temperature=0.0)
        payload["format"] = schema.model_json_schema()

        async def once() -> T:
            try:
                async with self._client() as client:
                    res = await client.post("/api/chat", json=payload)
            except Exception as exc:
                raise self._error(exc, model) from exc
            if res.status_code >= 400:
                raise self._status_error(res.status_code, res.text, model)
            try:
                return schema.model_validate_json(res.json()["message"]["content"])
            except (ValidationError, ValueError, KeyError, TypeError) as exc:
                log.warning("Malformed structured response from Ollama model %s", model)
                raise LLMError("The local model returned a malformed response.", "llm_malformed") from exc

        return await call_with_retries(once, self.settings.llm_max_retries, self.name)
