"""Repeatable RAG evaluation over sample_docs/ and eval/questions.json.

    python -m eval.run_eval            # retrieval metrics only (no API key needed)
    python -m eval.run_eval --llm      # also generate answers with the configured LLM
    python -m eval.run_eval --llm --pause 15   # spaced out for free-tier rate limits

Metrics are simple, transparent checks — not a substitute for human review.
"""
import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

from app.core.config import Settings, get_settings
from app.services.answer_generation import ChatService
from app.services.knowledge_base import KnowledgeBase
from app.services.llm import GeminiClient

ROOT = Path(__file__).resolve().parent.parent
REFUSAL = "couldn't find enough information"


def pct(a: int, b: int) -> str:
    return f"{a}/{b} ({100 * a / b:.0f}%)" if b else "n/a"


async def main(use_llm: bool, pause: float = 0.0) -> int:
    base = get_settings()
    questions = json.loads((ROOT / "eval" / "questions.json").read_text())
    with tempfile.TemporaryDirectory() as tmp:
        settings = Settings(**{**base.model_dump(), "data_dir": Path(tmp)})
        kb = KnowledgeBase(settings)
        for path in sorted((ROOT / "sample_docs").iterdir()):
            doc = kb.add_upload(path.name, path.read_bytes())
            kb.index(doc.id)
            print(f"indexed {path.name}: {kb.get(doc.id).status} ({kb.get(doc.id).chunk_count} chunks)")
        if use_llm and not settings.llm_configured:
            print("GEMINI_API_KEY is not set; cannot run --llm.", file=sys.stderr)
            return 2
        rag = ChatService(kb, settings, GeminiClient(settings))

        retr_ok = retr_total = abstain_ok = abstain_total = 0
        cite_ok = cite_total = support_ok = support_total = refuse_ok = 0
        print(f"\nthreshold={settings.min_similarity} top_k={settings.top_k}\n")
        for q in questions:
            hits = [h for h in kb.search(q["question"], settings.top_k) if h.score >= settings.min_similarity]
            expected = set(q["expected_sources"])
            answerable = q.get("answerable", True)
            if answerable:
                retr_total += 1
                found = expected & {h.filename for h in hits}
                pages_ok = all(any(h.page == p for h in hits) for p in q.get("expected_pages", []))
                ok = bool(found) and pages_ok
                retr_ok += ok
            else:
                abstain_total += 1
                ok = not hits
                abstain_ok += ok
            top = f"{hits[0].filename} p{hits[0].page} {hits[0].score:.2f}" if hits else "-"
            line = f"[{'PASS' if ok else 'FAIL'}] retrieval  {q['id']:<22} top: {top}"

            if use_llm:
                if hits and pause:  # free-tier keys allow only a few requests per minute
                    await asyncio.sleep(pause)
                events = [e async for e in rag.answer(q["question"], [])]
                last = events[-1]
                answer = "".join(e.get("text", "") for e in events if e["type"] == "delta")
                if last["type"] == "error":
                    line += f"\n        LLM error: {last['message']}"
                else:
                    cited = {c["filename"] for c in last["citations"]}
                    if answerable:
                        cite_total += 1
                        c_ok = bool(cited) and cited <= expected
                        cite_ok += c_ok
                        kws = q.get("expected_keywords", [])
                        bad = [s for s in q.get("must_not_contain", []) if s.lower() in answer.lower()]
                        s_ok = (not kws or any(k.lower() in answer.lower() for k in kws)) and not bad
                        support_total += 1
                        support_ok += s_ok
                        line += f"\n        citations {'ok ' if c_ok else 'BAD'} {sorted(cited)} | support {'ok' if s_ok else 'MISSING'}"
                    else:
                        r_ok = not cited and REFUSAL in answer.lower()
                        refuse_ok += r_ok
                        line += f"\n        abstained {'ok' if r_ok else 'NO'}"
            print(line)

        print("\n=== Summary ===")
        print(f"Retrieval hit (expected source/page in evidence): {pct(retr_ok, retr_total)}")
        print(f"No evidence above threshold for unanswerable:   {pct(abstain_ok, abstain_total)}")
        if use_llm:
            print(f"Citation correctness (cited ⊆ expected, ≥1):    {pct(cite_ok, cite_total)}")
            print(f"Answer support (expected keyword present):       {pct(support_ok, support_total)}")
            print(f"Correct abstention on unanswerable:              {pct(refuse_ok, abstain_total)}")
        print("\nSimilarity scores measure relevance, not factual correctness. Review answers manually.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--llm", action="store_true", help="also generate and check answers with the real LLM")
    parser.add_argument("--pause", type=float, default=0.0, help="seconds to wait between LLM calls (e.g. 15 on free tiers)")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.llm, args.pause)))
