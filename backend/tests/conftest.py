import hashlib
import math
import re

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.conversation import rule_based_plan


_STOP = set("the and for what how does are was with this that from any all can you your have has into its may".split())


def fake_embedder(texts: list[str]) -> list[list[float]]:
    """Deterministic hashed bag-of-words embedding: keyword overlap (ignoring filler words) ⇒ cosine similarity."""
    out = []
    for text in texts:
        v = [0.0] * 256
        for word in re.findall(r"[a-z0-9]+", text.lower()):
            if len(word) > 2 and word not in _STOP:
                v[int(hashlib.md5(word.encode()).hexdigest(), 16) % 256] += 1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        out.append([x / norm for x in v])
    return out


class FakeLLM:
    """Test double for the LLM provider. Records every call; streams a scripted answer.
    The router step returns `plan` (a QueryPlan or a function of the latest message), else the rule-based plan."""

    def __init__(self):
        self.calls: list[tuple[str, list[dict]]] = []
        self.router_calls: list[str] = []
        self.reply = "The restocking fee is 10 percent [1]."
        self.error: Exception | None = None
        self.plan = None
        self.router_error: Exception | None = None

    name = "fake"

    def factory(self, _settings):
        return self

    async def stream(self, system, messages, meta=None):
        if meta is not None:
            meta["provider"] = self.name
        self.calls.append((system, messages))
        if self.error:
            raise self.error
        for word in self.reply.split(" "):
            yield word + " "

    async def structured(self, system, prompt, schema):
        self.router_calls.append(prompt)
        if self.router_error:
            raise self.router_error
        message = prompt.split("<latest_message>\n", 1)[1].rsplit("\n</latest_message>", 1)[0]
        if self.plan is None:
            return rule_based_plan(message)
        return self.plan(message) if callable(self.plan) else self.plan


@pytest.fixture
def settings(tmp_path):
    return Settings(_env_file=None, gemini_api_key="test-key", data_dir=tmp_path, min_similarity=0.2, max_upload_mb=1)


@pytest.fixture
def llm():
    return FakeLLM()


@pytest.fixture
def client(settings, llm):
    app = create_app(settings, embedder=fake_embedder, llm_factory=llm.factory)
    with TestClient(app) as c:
        yield c


def upload(client, name: str, data: bytes):
    return client.post("/api/documents", files={"file": (name, data)})


def chat(client, question: str, history=None, doc_ids=None) -> list[dict]:
    import json

    res = client.post("/api/chat", json={"question": question, "history": history or [], "doc_ids": doc_ids})
    assert res.status_code == 200, res.text
    return [json.loads(line) for line in res.text.splitlines() if line.strip()]
