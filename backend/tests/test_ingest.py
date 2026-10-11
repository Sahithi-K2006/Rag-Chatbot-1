import pytest

from app.services.document_processing import IngestError, Page, chunk_pages, chunk_text, extract_headings, extract_pages, validate_upload
from scripts.make_sample_pdf import make_pdf

MB = 1024 * 1024


@pytest.mark.parametrize(
    "name,data,message",
    [
        ("notes.docx", b"hello", "Unsupported file type"),
        ("noext", b"hello", "Unsupported file type"),
        ("empty.txt", b"", "empty"),
        ("big.txt", b"a" * (MB + 1), "larger than"),
        ("fake.pdf", b"not a pdf at all", "not a valid PDF"),
        ("binary.txt", b"\x00\x01\x02binary", "looks binary"),
    ],
)
def test_validate_upload_rejects(name, data, message):
    with pytest.raises(IngestError, match=message):
        validate_upload(name, data, MB)


def test_validate_upload_accepts_and_normalises():
    assert validate_upload("Notes.MD", b"# hi", MB) == ".md"
    assert validate_upload("x.markdown", b"# hi", MB) == ".md"
    assert validate_upload("a.pdf", make_pdf([["hi"]]), MB) == ".pdf"


def test_extract_text_and_markdown():
    pages = extract_pages("Café\r\n\r\n\r\n\r\nline   two".encode("utf-8-sig"), ".txt")
    assert len(pages) == 1 and pages[0].page is None
    assert pages[0].text == "Café\n\nline two"


def test_extract_pdf_keeps_page_numbers():
    pdf = make_pdf([["Alpha page one (intro)"], ["Beta page two"]])
    pages = extract_pages(pdf, ".pdf")
    assert [p.page for p in pages] == [1, 2]
    assert "Alpha page one (intro)" in pages[0].text
    assert "Beta page two" in pages[1].text


def test_extract_pdf_skips_blank_pages_but_keeps_numbering():
    pages = extract_pages(make_pdf([["first"], [], ["third"]]), ".pdf")
    assert [p.page for p in pages] == [1, 3]


def test_empty_and_corrupt_documents():
    with pytest.raises(IngestError, match="No readable text"):
        extract_pages(b"   \n\n  ", ".txt")
    with pytest.raises(IngestError, match="No readable text"):
        extract_pages(make_pdf([[]]), ".pdf")
    with pytest.raises(IngestError, match="could not be read"):
        extract_pages(b"%PDF-1.4\ngarbage that is not a pdf", ".pdf")


def test_chunk_text_sizes_overlap_and_coverage():
    words = [f"word{i}" for i in range(600)]
    text = " ".join(words)
    chunks = chunk_text(text, size=300, overlap=60)
    assert len(chunks) > 1
    assert all(len(c) <= 300 for c in chunks)
    # consecutive chunks share context
    for a, b in zip(chunks, chunks[1:]):
        assert b.split()[0] in a
    # nothing lost: every word appears somewhere
    joined = " ".join(chunks)
    assert all(w in joined for w in words)
    # never cut mid-word
    assert all(c.split()[0] in words and c.split()[-1] in words for c in chunks)


def test_chunk_text_prefers_sentence_boundaries():
    text = "First sentence is here. " * 30
    for c in chunk_text(text, size=200, overlap=0):
        assert c.endswith(".")


def test_chunk_text_short_and_invalid():
    assert chunk_text("short", 100, 10) == ["short"]
    with pytest.raises(ValueError):
        chunk_text("x", 100, 100)


def test_chunk_pages_preserves_page_metadata_and_index():
    pages = [Page("a " * 400, 1), Page("b " * 400, 2)]
    chunks = chunk_pages(pages, size=300, overlap=50)
    assert [c.index for c in chunks] == list(range(len(chunks)))
    assert {c.page for c in chunks} == {1, 2}
    assert all(("a" in c.text) != ("b" in c.text) for c in chunks)  # never crosses a page


def test_extract_headings():
    pages = [Page("# Title\n\ntext\n## Paid time off\n### Remote work\n#### too deep", None)]
    assert extract_headings(pages) == ["Title", "Paid time off", "Remote work"]
