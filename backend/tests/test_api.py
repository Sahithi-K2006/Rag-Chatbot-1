from app.core.config import Settings
from app.main import create_app
from app.services.answer_generation import NO_EVIDENCE
from app.services.llm import LLMError
from fastapi.testclient import TestClient
from scripts.make_sample_pdf import make_pdf

from .conftest import chat, fake_embedder, upload

POLICY = make_pdf([
    ["Returns policy", "Opened items are subject to a 10 percent restocking fee."],
    ["Refunds are processed within 7 business days."],
])
FAQ = b"Tents carry a 2-year warranty against manufacturing defects in poles and zips."


def test_health_and_settings_hide_secrets(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/ready").json()["llm_configured"] is True
    body = client.get("/api/settings").text
    assert "test-key" not in body
    assert '"configured":true' in body.replace(" ", "")


def test_upload_index_list_and_metadata(client):
    res = upload(client, "policy.pdf", POLICY)
    assert res.status_code == 202
    doc_id = res.json()["document"]["id"]
    doc = client.get(f"/api/documents/{doc_id}").json()  # background task already ran
    assert doc["status"] == "indexed"
    assert doc["page_count"] == 2 and doc["chunk_count"] == 2
    assert [d["id"] for d in client.get("/api/documents").json()] == [doc_id]


def test_duplicate_upload_returns_existing_record(client):
    first = upload(client, "faq.txt", FAQ).json()["document"]
    again = upload(client, "faq-copy.txt", FAQ)
    assert again.status_code == 200 and again.json()["duplicate"] is True
    assert again.json()["document"]["id"] == first["id"]
    assert len(client.get("/api/documents").json()) == 1


def test_invalid_uploads(client):
    assert upload(client, "x.exe", b"MZ").status_code == 415
    big = upload(client, "big.txt", b"a" * (1024 * 1024 + 10))
    assert big.status_code == 413 and "limit" in big.json()["detail"]["message"]
    assert upload(client, "empty.md", b"").status_code == 400
    assert client.post("/api/documents").status_code == 422


def test_unreadable_document_is_marked_failed_not_indexed(client):
    res = upload(client, "blank.pdf", make_pdf([[]]))
    doc = client.get(f"/api/documents/{res.json()['document']['id']}").json()
    assert doc["status"] == "failed" and "No readable text" in doc["error"]


def test_chat_answer_cites_the_supporting_document(client, llm):
    upload(client, "faq.txt", FAQ)
    upload(client, "policy.pdf", POLICY)
    events = chat(client, "What is the restocking fee for opened items?")
    text = "".join(e["text"] for e in events if e["type"] == "delta")
    done = events[-1]
    assert done["type"] == "done" and done["grounded"] is True
    assert "10 percent" in text
    [cite] = done["citations"]
    assert cite["filename"] == "policy.pdf" and cite["page"] == 1 and "restocking" in cite["text"]
    # retrieved context reached the model as data, with the strict system prompt
    system, messages = llm.calls[0]
    assert "untrusted data" in system
    assert "<retrieved_sources>" in messages[-1]["content"]


def test_unsupported_question_never_calls_llm(client, llm):
    upload(client, "faq.txt", FAQ)
    events = chat(client, "Who won the football world cup?")
    assert events[0]["text"] == NO_EVIDENCE["en"]
    assert events[-1]["mode"] == "no_evidence" and events[-1]["citations"] == [] and events[-1]["grounded"] is False
    assert llm.calls == []


def test_empty_knowledge_base(client, llm):
    events = chat(client, "Anything?")
    assert events[-1]["grounded"] is False and events[-1]["retrieved"] == 0


def test_model_admitting_insufficient_info_has_no_citations(client, llm):
    upload(client, "faq.txt", FAQ)
    llm.reply = "I couldn't find enough information in your documents to answer that."
    done = chat(client, "What warranty applies to tents bought abroad?")[-1]
    assert done["citations"] == [] and done["grounded"] is False


def test_failed_model_request_returns_error_event(client, llm):
    upload(client, "faq.txt", FAQ)
    llm.error = LLMError("The language model is rate-limited right now.", "llm_rate_limit")
    events = chat(client, "What warranty do tents have?")
    assert events[-1] == {"type": "error", "code": "llm_rate_limit", "message": "The language model is rate-limited right now."}


def test_missing_api_configuration(tmp_path, llm):
    s = Settings(_env_file=None, gemini_api_key="", data_dir=tmp_path, min_similarity=0.2)
    with TestClient(create_app(s, embedder=fake_embedder, llm_factory=llm.factory)) as c:
        assert c.get("/api/ready").json()["llm_configured"] is False
        upload(c, "faq.txt", FAQ)
        events = chat(c, "What warranty do tents have?")
        assert events[-1]["type"] == "error" and events[-1]["code"] == "llm_not_configured"
        assert llm.calls == []


def test_empty_and_malformed_chat_inputs(client):
    r = client.post("/api/chat", json={"question": "   "})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "empty_question"
    r = client.post("/api/chat", json={"question": "x" * 2001})
    assert r.json()["detail"]["code"] == "question_too_long"
    r = client.post("/api/chat", json={"nope": 1})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_request"
    r = client.post("/api/chat", json={"question": "hi", "history": [{"role": "system", "content": "x"}]})
    assert r.status_code == 422
    r = client.post("/api/chat", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_delete_removes_document_and_its_vectors(client, llm):
    doc_id = upload(client, "faq.txt", FAQ).json()["document"]["id"]
    assert client.delete(f"/api/documents/{doc_id}").status_code == 204
    assert client.get("/api/documents").json() == []
    assert client.delete(f"/api/documents/{doc_id}").status_code == 404
    assert chat(client, "What warranty do tents have?")[-1]["retrieved"] == 0


def test_reindex(client):
    doc_id = upload(client, "faq.txt", FAQ).json()["document"]["id"]
    res = client.post(f"/api/documents/{doc_id}/reindex")
    assert res.status_code == 202
    doc = client.get(f"/api/documents/{doc_id}").json()
    assert doc["status"] == "indexed" and doc["chunk_count"] == 1
    assert client.post("/api/documents/missing/reindex").status_code == 404


def test_embedding_failure_marks_document_failed(tmp_path, llm):
    def broken(_texts):
        raise RuntimeError("model crashed")

    s = Settings(_env_file=None, gemini_api_key="k", data_dir=tmp_path)
    with TestClient(create_app(s, embedder=broken, llm_factory=llm.factory)) as c:
        doc_id = upload(c, "faq.txt", FAQ).json()["document"]["id"]
        doc = c.get(f"/api/documents/{doc_id}").json()
        assert doc["status"] == "failed" and "embeddings" in doc["error"]
        assert "model crashed" not in doc["error"]


def test_suggestions_from_indexed_documents(client):
    upload(client, "handbook.md", b"# Handbook\n\n## Paid time off\n22 days.\n\n## Remote work\nTwo days.")
    s = client.get("/api/suggestions").json()
    assert "What does the handbook say about paid time off?" in s
    assert "What does handbook.md cover?" in s


def test_interrupted_processing_is_recovered_as_failed(settings, llm, tmp_path):
    with TestClient(create_app(settings, embedder=fake_embedder, llm_factory=llm.factory)) as c:
        doc_id = upload(c, "faq.txt", FAQ).json()["document"]["id"]
        c.app.state.kb._update(doc_id, status="processing")
    with TestClient(create_app(settings, embedder=fake_embedder, llm_factory=llm.factory)) as c:
        assert c.get(f"/api/documents/{doc_id}").json()["status"] == "failed"
