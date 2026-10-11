"""Regression tests for the reported bugs: answers must come from the uploaded documents, follow the
user's actual question, stay inside the selected documents, and handle chat/Telugu naturally."""
from app.core.config import Settings
from app.main import create_app
from app.services.answer_generation import NO_DOCUMENTS, NO_EVIDENCE
from app.services.conversation import QueryPlan, rule_based_plan
from app.services.llm import LLMError
from fastapi.testclient import TestClient
from scripts.make_sample_pdf import make_pdf

from .conftest import chat, fake_embedder, upload

DOC_A = make_pdf([["Zephyrine Lantern returns policy", "The Zephyrine Lantern may be returned within 33 days of delivery."]])
DOC_B = b"Shipping guide for the Quillobar Kettle. Shipping the Quillobar Kettle costs 17 dollars to any address."


def first_source(ctx: str) -> str:
    return ctx.split("<source ", 2)[1]


def sources_sent(llm) -> str:
    """The retrieved context the model actually received in the latest answer call."""
    return llm.calls[-1][1][-1]["content"]


def answer_text(events) -> str:
    return "".join(e["text"] for e in events if e["type"] == "delta")


def test_document_a_b_regression(client, llm):
    a = upload(client, "doc_a.pdf", DOC_A).json()["document"]["id"]
    b = upload(client, "doc_b.txt", DOC_B).json()["document"]["id"]

    # Question about A: the model receives A's passage, not B's, and the citation points at A.
    llm.reply = "You can return it within 33 days [1]."
    done = chat(client, "How many days do I have to return the Zephyrine Lantern?")[-1]
    ctx = sources_sent(llm)
    assert "33 days" in first_source(ctx) and "Quillobar" not in first_source(ctx)  # A ranks first
    assert [c["doc_id"] for c in done["citations"]] == [a]

    # Question about B: evidence and citation switch to B.
    llm.reply = "Shipping costs 17 dollars [1]."
    done = chat(client, "What does shipping the Quillobar Kettle cost?")[-1]
    ctx = sources_sent(llm)
    assert "17 dollars" in first_source(ctx) and "Zephyrine" not in first_source(ctx)  # B ranks first
    assert [c["doc_id"] for c in done["citations"]] == [b]

    # Information in neither document: honest refusal, model not asked to answer.
    calls_before = len(llm.calls)
    events = chat(client, "What is the warranty period for the Marbleton Sofa?")
    assert answer_text(events) == NO_EVIDENCE["en"] and events[-1]["mode"] == "no_evidence"
    assert len(llm.calls) == calls_before

    # A question that is in no sample list still goes through retrieval (router + vector search).
    router_before = len(llm.router_calls)
    llm.reply = "It costs 17 dollars to ship [1]."
    done = chat(client, "kettle delivery price quillobar??")[-1]
    assert len(llm.router_calls) == router_before + 1
    assert done["retrieved"] >= 1 and done["citations"][0]["doc_id"] == b


def test_changing_the_document_changes_the_evidence(client, llm):
    doc_id = upload(client, "policy.txt", b"Returns for the Orbix Lamp are accepted within 30 days.").json()["document"]["id"]
    chat(client, "How long are Orbix Lamp returns accepted?")
    assert "30 days" in sources_sent(llm)
    client.delete(f"/api/documents/{doc_id}")
    upload(client, "policy_v2.txt", b"Returns for the Orbix Lamp are accepted within 60 days.")
    chat(client, "How long are Orbix Lamp returns accepted?")
    assert "60 days" in sources_sent(llm) and "30 days" not in sources_sent(llm)


def test_selected_document_scope_prevents_cross_contamination(client, llm):
    a = upload(client, "store_a.txt", b"Store A returns policy: returns are accepted within 21 days.").json()["document"]["id"]
    upload(client, "store_b.txt", b"Store B returns policy: returns are accepted within 45 days.")
    llm.reply = "Returns are accepted within 21 days [1]."
    done = chat(client, "What is the returns policy?", doc_ids=[a])[-1]
    ctx = sources_sent(llm)
    assert "21 days" in ctx and "45 days" not in ctx
    assert {c["doc_id"] for c in done["citations"]} == {a}
    # Unknown/unready ids are rejected instead of silently searching everything.
    r = client.post("/api/chat", json={"question": "returns?", "doc_ids": ["nope"]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "documents_not_ready"


def test_greeting_gets_model_reply_without_retrieval_or_documents(client, llm):
    llm.plan = QueryPlan(intent="smalltalk", language="en", reply="Hii! 😊 Welcome to KnowledgeBridge AI.")
    events = chat(client, "Hii")  # no documents uploaded at all
    assert answer_text(events) == "Hii! 😊 Welcome to KnowledgeBridge AI."
    assert events[-1]["mode"] == "conversation" and events[-1]["citations"] == []
    assert llm.calls == []  # no answer-generation call, no retrieval


def test_telugu_question_is_rewritten_and_retrieves_english_passage(client, llm):
    doc = upload(client, "refunds.txt", b"Refunds are processed within 5 to 7 business days after inspection.").json()["document"]["id"]
    # The router translates/normalises the Telugu-English question into an English search query.
    llm.plan = lambda msg: QueryPlan(intent="document", language="te-Latn", search_query="How many days does a refund take to process?")
    llm.reply = "Refund 5 nunchi 7 business days lo process avuthundi [1]."
    done = chat(client, "refund entha days lo osthundi?", doc_ids=[doc])[-1]
    assert done["language"] == "te-Latn" and done["search_query"].startswith("How many days")
    assert "5 to 7 business days" in sources_sent(llm)
    assert "Telugu written in English letters" in sources_sent(llm)  # answer-language instruction
    assert done["citations"][0]["doc_id"] == doc


def test_no_evidence_message_is_in_the_users_language(client, llm):
    upload(client, "refunds.txt", b"Refunds are processed within 5 to 7 business days.")
    llm.plan = QueryPlan(intent="document", language="te", search_query="warranty period for the marbleton sofa")
    events = chat(client, "సోఫా వారంటీ ఎంత?")
    assert answer_text(events) == NO_EVIDENCE["te"]


def test_summary_question_uses_document_passages(client, llm):
    doc = upload(client, "guide.txt", ("Section one covers onboarding. " * 40 + "Section two covers expenses. " * 40).encode()).json()["document"]["id"]
    llm.plan = QueryPlan(intent="summary", language="en", search_query="overview of the document")
    llm.reply = "The guide covers onboarding [1] and expenses [2]."
    done = chat(client, "What is this PDF about?", doc_ids=[doc])[-1]
    ctx = sources_sent(llm)
    assert done["mode"] == "summary" and "onboarding" in ctx and "expenses" in ctx
    assert "overview" in ctx.lower()
    assert len(done["citations"]) == 2 and done["citations"][0]["score"] is None


def test_no_documents_ready(client, llm):
    events = chat(client, "What are the return rules?")
    assert answer_text(events) == NO_DOCUMENTS["en"] and events[-1]["mode"] == "no_documents"


def test_router_failure_falls_back_to_raw_question_retrieval(client, llm):
    upload(client, "faq.txt", b"The Cedar Travel Mug holds 450 ml.")
    llm.router_error = LLMError("rate limited", "llm_rate_limit")
    llm.reply = "It holds 450 ml [1]."
    done = chat(client, "What is the Cedar Travel Mug capacity?")[-1]
    assert done["type"] == "done" and done["citations"] and "450 ml" in sources_sent(llm)


def test_follow_up_uses_history_and_rewritten_query(client, llm):
    upload(client, "returns.txt", b"Opened items carry a 10 percent restocking fee. Unopened items get a full refund.")
    llm.plan = QueryPlan(intent="document", language="en", search_query="restocking fee for opened items")
    llm.reply = "Opened items carry a 10 percent fee [1]."
    history = [{"role": "user", "content": "What is the returns policy?"}, {"role": "assistant", "content": "Unopened items get a full refund."}]
    chat(client, "and for opened ones?", history=history)
    sent = llm.calls[-1][1]
    assert sent[0]["content"] == "What is the returns policy?" and "restocking fee" in sent[-1]["content"]
    assert "What is the returns policy?" in llm.router_calls[-1]  # router saw the conversation


def test_rule_based_plan():
    assert rule_based_plan("Hii").intent == "smalltalk"
    assert rule_based_plan("thank you 😊").intent == "smalltalk"
    assert rule_based_plan("What is this PDF about?").intent == "summary"
    assert rule_based_plan("Ee document lo main points enti?").intent == "summary"
    assert rule_based_plan("what r the return rules?").intent == "document"
    assert rule_based_plan("నమస్తే").language == "te"
    assert rule_based_plan("refund entha days lo osthundi?").language == "te-Latn"
    assert rule_based_plan("what r the return rules?").language == "en"
    assert rule_based_plan("Ee documents lo main points enti?").intent == "summary"


def test_router_language_guard_corrects_tenglish_labelled_english(client, llm):
    upload(client, "refunds.txt", b"Refunds are processed within 5 to 7 business days.")
    llm.plan = QueryPlan(intent="document", language="en", search_query="refund processing time")
    done = chat(client, "refund entha days lo osthundi?")[-1]
    assert done["language"] == "te-Latn"


def test_access_key_protects_api(tmp_path, llm):
    s = Settings(_env_file=None, gemini_api_key="k", data_dir=tmp_path, api_access_key="s3cret")
    with TestClient(create_app(s, embedder=fake_embedder, llm_factory=llm.factory)) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/api/ready").json()["access_key_required"] is True
        assert c.get("/api/documents").status_code == 401
        assert c.delete("/api/documents/x").status_code == 401
        assert c.post("/api/chat", json={"question": "hi"}).status_code == 401
        assert c.get("/api/documents", headers={"X-Access-Key": "wrong"}).status_code == 401
        assert c.get("/api/documents", headers={"X-Access-Key": "s3cret"}).status_code == 200


def test_chat_rate_limit(tmp_path, llm):
    s = Settings(_env_file=None, gemini_api_key="k", data_dir=tmp_path, chat_requests_per_minute=2)
    with TestClient(create_app(s, embedder=fake_embedder, llm_factory=llm.factory)) as c:
        codes = [c.post("/api/chat", json={"question": "hello there"}).status_code for _ in range(3)]
        assert codes == [200, 200, 429]


def test_cors_origins_accept_comma_separated_env(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://kb.example.com/, http://localhost:5173")
    assert Settings(_env_file=None).cors_origins == ["https://kb.example.com", "http://localhost:5173"]


def test_two_level_threshold_keeps_neighbouring_context(tmp_path, llm):
    """A passage just under min_similarity is still sent once the best passage proves the topic is covered."""
    s = Settings(_env_file=None, gemini_api_key="k", data_dir=tmp_path, min_similarity=0.5, context_min_similarity=0.1)
    with TestClient(create_app(s, embedder=fake_embedder, llm_factory=llm.factory)) as c:
        upload(c, "a.txt", b"Returns policy: returns accepted within 21 days.")
        upload(c, "b.txt", b"Returns need original tags and an order number for policy checks.")
        chat(c, "returns policy within days")
        ctx = sources_sent(llm)
        assert "21 days" in ctx and "original tags" in ctx
        calls = len(llm.calls)
        chat(c, "tags")  # best passage below 0.5: not covered, model not asked
        assert len(llm.calls) == calls


def test_production_requires_access_key(tmp_path):
    import pytest

    with pytest.raises(RuntimeError, match="API_ACCESS_KEY"):
        create_app(Settings(_env_file=None, data_dir=tmp_path, environment="production"))
    create_app(Settings(_env_file=None, data_dir=tmp_path, environment="production", api_access_key="x"))


def test_router_can_be_disabled_to_save_quota(tmp_path, llm):
    s = Settings(_env_file=None, gemini_api_key="k", data_dir=tmp_path, llm_router_model="", min_similarity=0.2)
    with TestClient(create_app(s, embedder=fake_embedder, llm_factory=llm.factory)) as c:
        upload(c, "faq.txt", b"The Cedar Travel Mug holds 450 ml.")
        llm.reply = "It holds 450 ml [1]."
        done = chat(c, "What is the Cedar Travel Mug capacity?")[-1]
        assert llm.router_calls == [] and len(llm.calls) == 1 and done["citations"]
