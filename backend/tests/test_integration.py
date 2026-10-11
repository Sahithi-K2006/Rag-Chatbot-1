"""Integration tests: real Sentence Transformers + ChromaDB, and (opt-in) the real LLM."""
import asyncio
import os
from pathlib import Path

import pytest

from app.core.config import Settings
from app.services.answer_generation import ChatService
from app.services.knowledge_base import KnowledgeBase
from app.services.llm import build_llm

SAMPLES = Path(__file__).resolve().parent.parent / "sample_docs"


@pytest.fixture(scope="module")
def kb(tmp_path_factory):
    settings = Settings(_env_file=None, gemini_api_key="", data_dir=tmp_path_factory.mktemp("kb"))
    kb = KnowledgeBase(settings)
    for path in sorted(SAMPLES.iterdir()):
        doc = kb.add_upload(path.name, path.read_bytes())
        kb.index(doc.id)
        assert kb.get(doc.id).status == "indexed", kb.get(doc.id).error
    return kb


@pytest.mark.integration
@pytest.mark.parametrize(
    "question,filename,page",
    [
        ("What is the restocking fee for opened items?", "returns_policy.pdf", 1),
        ("How long does it take to process a refund?", "returns_policy.pdf", 2),
        ("What warranty do TrailLite tents have?", "product_faq.txt", None),
        ("How much PTO do full-time employees get?", "employee_handbook.md", None),
    ],
)
def test_real_embedding_retrieval(kb, question, filename, page):
    top = kb.search(question, 3)[0]
    assert top.filename == filename
    assert top.page == page
    assert top.score >= kb.settings.min_similarity


@pytest.mark.integration
def test_unrelated_question_scores_below_threshold(kb):
    hits = kb.search("What is the boiling point of mercury on Venus?", 5)
    assert all(h.score < kb.settings.min_similarity for h in hits)


REAL_LLM = pytest.mark.skipif(os.getenv("RUN_LLM_INTEGRATION") != "1", reason="set RUN_LLM_INTEGRATION=1 and configure a provider")
REAL_OLLAMA = pytest.mark.skipif(os.getenv("RUN_OLLAMA_INTEGRATION") != "1", reason="set RUN_OLLAMA_INTEGRATION=1 and OLLAMA_MODEL")


def _real_service(kb, **overrides):
    settings = Settings(**overrides)  # reads backend/.env / environment
    assert settings.llm_configured, f"provider {settings.llm_provider} is not configured"
    settings = settings.model_copy(update={"data_dir": kb.settings.data_dir})
    return ChatService(kb, settings, build_llm(settings))


def _run(service, question, doc_ids=None):
    events = asyncio.run(_collect(service, question, doc_ids))
    return events, "".join(e.get("text", "") for e in events if e["type"] == "delta")


async def _collect(service, question, doc_ids):
    return [e async for e in service.answer(question, [], doc_ids)]


@pytest.mark.llm
@REAL_LLM
def test_real_llm_grounded_answer_refusal_and_telugu(kb):
    """A handful of real Gemini calls (router + answer each). Free-tier keys allow only a few per minute."""
    service = _real_service(kb)

    events, text = _run(service, "What is the restocking fee for opened items?")
    assert events[-1]["type"] == "done", events[-1]
    assert any(c["filename"] == "returns_policy.pdf" for c in events[-1]["citations"]), text

    events, text = _run(service, "What is the CEO's annual salary?")
    assert events[-1]["type"] == "done" and events[-1]["citations"] == [], text

    events, text = _run(service, "refund entha days lo osthundi?")
    assert events[-1]["type"] == "done", events[-1]
    assert events[-1]["language"] in ("te-Latn", "te"), events[-1]
    assert any(c["filename"] == "returns_policy.pdf" for c in events[-1]["citations"]), text
    assert "7" in text, text

    events, text = _run(service, "Hii")
    assert events[-1]["mode"] == "conversation" and text.strip(), events[-1]


@pytest.mark.llm
@REAL_OLLAMA
def test_real_ollama_grounded_answer_and_refusal(kb):
    """Local model via Ollama: router + answer. Slow on laptops (the first call loads the model)."""
    model = os.environ.get("OLLAMA_MODEL", "gemma4:latest")
    service = _real_service(kb, llm_provider="ollama", ollama_model=model, llm_fallback_provider="")

    events, text = _run(service, "How long do approved refunds take to process?")
    assert events[-1]["type"] == "done" and events[-1]["provider"] == "ollama", events[-1]
    assert any(c["filename"] == "returns_policy.pdf" for c in events[-1]["citations"]), text
    assert "7" in text, text

    events, text = _run(service, "What is the CEO's annual salary?")
    assert events[-1]["type"] == "done" and events[-1]["citations"] == [], text
