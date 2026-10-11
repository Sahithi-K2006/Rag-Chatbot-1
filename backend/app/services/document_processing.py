"""File validation, text extraction and chunking. Pure functions, no I/O beyond the bytes given."""
import io
import logging
import re
from dataclasses import dataclass
from pathlib import PurePath

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from ..core.config import ALLOWED_EXTENSIONS

log = logging.getLogger(__name__)


class IngestError(Exception):
    """Raised with a message that is safe to show to end users."""


@dataclass
class Page:
    text: str
    page: int | None  # 1-based page number; None when the format has no pages


@dataclass
class Chunk:
    text: str
    page: int | None
    index: int  # position of the chunk within its document


def validate_upload(filename: str, data: bytes, max_bytes: int) -> str:
    """Returns the normalised extension or raises IngestError."""
    ext = PurePath(filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise IngestError(f"Unsupported file type '{ext or 'none'}'. Upload PDF, TXT or Markdown files.")
    if not data:
        raise IngestError("The file is empty.")
    if len(data) > max_bytes:
        raise IngestError(f"The file is larger than the {max_bytes // (1024 * 1024)} MB limit.")
    if ext == ".pdf" and not data.lstrip()[:5] == b"%PDF-":
        raise IngestError("This file has a .pdf extension but is not a valid PDF.")
    if ext != ".pdf" and b"\x00" in data[:8192]:
        raise IngestError("This file looks binary, not text. Upload a plain-text or Markdown file.")
    return ".md" if ext == ".markdown" else ext


def extract_pages(data: bytes, ext: str) -> list[Page]:
    if ext == ".pdf":
        pages = _extract_pdf(data)
    else:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("cp1252", errors="replace")
        pages = [Page(text=text, page=None)]
    pages = [Page(_normalise(p.text), p.page) for p in pages]
    pages = [p for p in pages if p.text]
    if not pages:
        hint = " Scanned/image-only PDFs need OCR, which this demo does not include." if ext == ".pdf" else ""
        raise IngestError("No readable text was found in this file." + hint)
    return pages


def _extract_pdf(data: bytes) -> list[Page]:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise IngestError("This PDF is password-protected. Remove the password and upload it again.")
        return [Page(text=page.extract_text() or "", page=i) for i, page in enumerate(reader.pages, start=1)]
    except IngestError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        log.warning("PDF extraction failed: %s", type(exc).__name__)
        raise IngestError("The PDF could not be read. It may be corrupted or use an unsupported format.") from exc


def _normalise(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    """Split text into ~size-char chunks with `overlap` chars of shared context,
    preferring to cut at paragraph, sentence, then word boundaries."""
    if overlap >= size:
        raise ValueError("overlap must be smaller than size")
    chunks: list[str] = []
    start, n = 0, len(text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            floor = start + size // 2
            for sep, keep in (("\n\n", 0), (". ", 1), ("\n", 0), (" ", 0)):
                pos = text.rfind(sep, floor, end)
                if pos > floor:
                    end = pos + keep
                    break
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= n:
            break
        next_start = max(end - overlap, start + 1)
        space = text.find(" ", next_start, end)
        start = space + 1 if overlap and space != -1 else next_start
    return chunks


def chunk_pages(pages: list[Page], size: int, overlap: int) -> list[Chunk]:
    """Chunks never cross page boundaries, so every chunk keeps an exact page number."""
    out: list[Chunk] = []
    for page in pages:
        for piece in chunk_text(page.text, size, overlap):
            out.append(Chunk(text=piece, page=page.page, index=len(out)))
    return out


def extract_headings(pages: list[Page], limit: int = 4) -> list[str]:
    """Markdown-style headings, used to suggest starter questions."""
    found: list[str] = []
    for page in pages:
        for m in re.finditer(r"^#{1,3}\s+(.{3,80})$", page.text, re.MULTILINE):
            heading = m.group(1).strip(" #")
            if heading not in found:
                found.append(heading)
            if len(found) >= limit:
                return found
    return found
