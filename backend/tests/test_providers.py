"""Provider layer: error classification, bounded retries, fallback rules, Ollama client, settings.
All mocked (fake clients / httpx MockTransport); see test_integration.py for real-provider checks."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors as genai_errors
from pydantic import ValidationError

from app.core.config import Settings
from app.services.conversation import QueryPlan
from app.services.llm import FallbackClient, LLMError, build_llm, retry_delay, startup_check, stream_with_retries
from app.services.providers.gemini import GeminiClient, to_llm_error
from app.services.providers.ollama import OllamaClient


def gemini_429(quota_id: str | None = None, retry: str | None = None, message="Resource exhausted"):
    details = []
    if quota_id:
        details.append({"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaId": quota_id}]})
    if retry:
        details.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry})
    return genai_errors.APIError(429, {"error": {"code": 429, "message": message, "status": "RESOURCE_EXHAUSTED", "details": details}})


def test_gemini_daily_quota_is_exhausted_not_rate_limit():
    err = to_llm_error(gemini_429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "37s"), "m")
    assert err.code == "llm_quota_exhausted" and retry_delay(err, 0) is None  # never retried


def test_gemini_per_minute_limit_is_retryable_with_retry_after():
    err = to_llm_error(gemini_429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "3s"), "m")
    assert err.code == "llm_rate_limit" and err.retry_after == 3.0 and retry_delay(err, 0) == 3.0


def test_rate_limit_with_long_retry_after_is_not_retried():
    err = to_llm_error(gemini_429("GenerateRequestsPerMinutePerProjectPerModel", "45s"), "m")
    assert err.code == "llm_rate_limit" and retry_delay(err, 0) is None  # too long to wait inside a request


def test_auth_model_and_bad_request_are_never_retried():
    for code in ("llm_auth", "llm_model", "llm_bad_request", "llm_quota_exhausted", "llm_malformed"):
        assert retry_delay(LLMError("x", code), 0) is None


def test_stream_retries_only_before_first_token(monkeypatch):
    async def no_wait(*_):
        return None

    monkeypatch.setattr("app.services.llm.asyncio.sleep", no_wait)
    attempts = {"n": 0}

    async def flaky_before():
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise LLMError("busy", "llm_unavailable")
        yield "ok"

    out = asyncio.run(_drain(stream_with_retries(flaky_before, 2, "t")))
    assert out == ["ok"] and attempts["n"] == 2

    async def fails_mid_stream():
        yield "partial "
        raise LLMError("busy", "llm_unavailable")

    with pytest.raises(LLMError):
        asyncio.run(_drain(stream_with_retries(fails_mid_stream, 2, "t")))  # no retry: text already shown


async def _drain(gen):
    return [x async for x in gen]


def test_quota_error_fails_fast_without_retrying():
    calls = []

    async def generate_content_stream(**kw):
        calls.append(kw)
        raise gemini_429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "20s")

    client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content_stream=generate_content_stream)))
    g = GeminiClient(Settings(_env_file=None, gemini_api_key="k", llm_max_retries=3), client=client)
    with pytest.raises(LLMError) as exc:
        asyncio.run(_drain(g.stream("sys", [{"role": "user", "content": "hi"}])))
    assert exc.value.code == "llm_quota_exhausted" and len(calls) == 1


class Scripted:
    def __init__(self, name, error=None, text="answer", ok=True):
        self.name, self.error, self.text, self.ok, self.calls = name, error, text, ok, 0

    async def check(self):
        return self.ok, "scripted"

    async def stream(self, system, messages, meta=None):
        self.calls += 1
        if meta is not None:
            meta["provider"] = self.name
        if self.error:
            raise self.error
        yield self.text

    async def structured(self, system, prompt, schema):
        if self.error:
            raise self.error
        return schema(intent="document", language="en", search_query=prompt)


def test_fallback_used_when_primary_quota_exhausted():
    fb = FallbackClient(Scripted("gemini", LLMError("quota", "llm_quota_exhausted")), Scripted("ollama", text="local answer"))
    status = asyncio.run(fb.startup_check())
    assert status["fallback_ready"] is True
    meta = {}
    assert asyncio.run(_drain(fb.stream("s", [], meta))) == ["local answer"]
    assert meta == {"provider": "ollama", "fallback_reason": "llm_quota_exhausted"}
    with pytest.raises(LLMError):  # routing doesn't use the fallback; the caller drops to rule-based routing
        asyncio.run(fb.structured("s", "q", QueryPlan))


def test_fallback_not_used_when_it_failed_startup_check():
    secondary = Scripted("ollama", ok=False)
    fb = FallbackClient(Scripted("gemini", LLMError("quota", "llm_quota_exhausted")), secondary)
    assert asyncio.run(fb.startup_check())["fallback_ready"] is False
    with pytest.raises(LLMError) as exc:
        asyncio.run(_drain(fb.stream("s", [])))
    assert exc.value.code == "llm_quota_exhausted" and secondary.calls == 0


def test_fallback_not_used_for_non_availability_errors():
    secondary = Scripted("ollama")
    fb = FallbackClient(Scripted("gemini", LLMError("bad", "llm_bad_request")), secondary)
    asyncio.run(fb.startup_check())
    with pytest.raises(LLMError):
        asyncio.run(_drain(fb.stream("s", [])))
    assert secondary.calls == 0


def test_chat_reports_provider_and_fallback(client, llm, tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app

    from .conftest import chat, fake_embedder, upload

    s = Settings(_env_file=None, gemini_api_key="k", data_dir=tmp_path / "fb", min_similarity=0.2, llm_router_enabled=False)
    fb = FallbackClient(Scripted("gemini", LLMError("quota", "llm_quota_exhausted")), Scripted("ollama", text="It holds 450 ml [1]."))
    with TestClient(create_app(s, embedder=fake_embedder, llm_factory=lambda _s: fb)) as c:
        assert c.get("/api/ready").json()["llm"]["fallback_ready"] is True
        upload(c, "faq.txt", b"The Cedar Travel Mug holds 450 ml.")
        done = chat(c, "Cedar Travel Mug capacity")[-1]
        assert done["provider"] == "ollama" and done["fallback_reason"] == "llm_quota_exhausted" and done["citations"]


def test_quota_error_reaches_client_as_error_event_not_answer(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app

    from .conftest import chat, fake_embedder, upload

    s = Settings(_env_file=None, gemini_api_key="k", data_dir=tmp_path, min_similarity=0.2, llm_router_enabled=False)
    primary = Scripted("gemini", LLMError("The Gemini quota for this API key is used up.", "llm_quota_exhausted"))
    with TestClient(create_app(s, embedder=fake_embedder, llm_factory=lambda _s: primary)) as c:
        upload(c, "faq.txt", b"The Cedar Travel Mug holds 450 ml.")
        events = chat(c, "Cedar Travel Mug capacity")
        assert [e["type"] for e in events] == ["error"] and events[0]["code"] == "llm_quota_exhausted"


# ---------- Ollama (mocked HTTP) ----------
def ollama(handler, **kw):
    s = Settings(_env_file=None, llm_provider="ollama", ollama_model="gemma4:latest", llm_max_retries=0, **kw)
    return OllamaClient(s, transport=httpx.MockTransport(handler))


def test_ollama_streams_ndjson_and_sends_system_prompt():
    seen = {}

    def handler(req):
        seen.update(json.loads(req.content))
        lines = [{"message": {"content": "Returns "}}, {"message": {"content": "within 21 days [1]."}}, {"done": True, "done_reason": "stop"}]
        return httpx.Response(200, content="\n".join(json.dumps(l) for l in lines))

    meta = {}
    out = asyncio.run(_drain(ollama(handler).stream("SYS", [{"role": "user", "content": "q"}], meta)))
    assert "".join(out) == "Returns within 21 days [1]."
    assert seen["messages"][0] == {"role": "system", "content": "SYS"} and seen["model"] == "gemma4:latest" and seen["think"] is False
    assert meta == {"provider": "ollama", "model": "gemma4:latest"}


def test_ollama_structured_uses_json_schema_format():
    seen = {}

    def handler(req):
        seen.update(json.loads(req.content))
        return httpx.Response(200, json={"message": {"content": json.dumps({"intent": "smalltalk", "language": "en", "reply": "Hi!"})}})

    plan = asyncio.run(ollama(handler).structured("SYS", "hi", QueryPlan))
    assert plan.intent == "smalltalk" and plan.reply == "Hi!" and seen["format"]["properties"]["intent"]


@pytest.mark.parametrize(
    "handler,code",
    [
        (lambda r: httpx.Response(404, json={"error": "model 'gemma4:latest' not found"}), "llm_model"),
        (lambda r: httpx.Response(500, json={"error": "boom"}), "llm_unavailable"),
        (lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")), "llm_network"),
        (lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")), "llm_timeout"),
        (lambda r: httpx.Response(200, content="not json\n"), "llm_malformed"),
    ],
)
def test_ollama_errors_are_classified(handler, code):
    with pytest.raises(LLMError) as exc:
        asyncio.run(_drain(ollama(handler).stream("s", [{"role": "user", "content": "q"}])))
    assert exc.value.code == code


def test_ollama_check_reports_missing_model():
    ok, detail = asyncio.run(ollama(lambda r: httpx.Response(200, json={"models": [{"name": "llama3:latest", "model": "llama3:latest"}]})).check())
    assert not ok and "ollama pull gemma4:latest" in detail
    ok, _ = asyncio.run(ollama(lambda r: httpx.Response(200, json={"models": [{"name": "gemma4:latest", "model": "gemma4:latest"}]})).check())
    assert ok


# ---------- settings ----------
def test_provider_settings_validation():
    with pytest.raises(ValidationError, match="OLLAMA_MODEL"):
        Settings(_env_file=None, llm_provider="ollama")
    with pytest.raises(ValidationError, match="must differ"):
        Settings(_env_file=None, llm_fallback_provider="gemini")
    s = Settings(_env_file=None, llm_provider="ollama", ollama_model="m", llm_fallback_provider="gemini")
    assert s.llm_configured and s.answer_model == "m" and isinstance(build_llm(s), FallbackClient)
    assert not Settings(_env_file=None).llm_configured  # gemini without key


def test_startup_check_never_calls_gemini():
    status = asyncio.run(startup_check(GeminiClient(Settings(_env_file=None, gemini_api_key=""))))
    assert status["ok"] is False and "GEMINI_API_KEY" in status["detail"]
