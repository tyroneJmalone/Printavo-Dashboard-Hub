"""Deterministic, offline text extraction for knowledge source ingestion."""
from __future__ import annotations
import csv, io, json, re, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree

def _is_list_item(line: str) -> bool:
    return bool(re.match(r"^(?:[-*•▪◦]|\d+[.)]|[a-z][.)])\s+", line, re.I))


def _is_explicit_heading(line: str) -> bool:
    if re.match(r"^#{1,6}\s+\S", line):
        return True
    if len(line) > 100 or re.search(r"[.!?;]$", line):
        return False
    words = line.split()
    if len(words) < 2 or len(words) > 12:
        return False
    return line.endswith(":") or all(re.match(r"^[A-Z0-9/&'()_-]+$", word) for word in words)


def reconstruct_pdf_text(pages: list[str]) -> str:
    """Turn visual PDF lines back into prose without inventing whitespace.

    pypdf generally returns a newline for every rendered line. Treat blank
    lines, explicit headings, and list items as structure; ordinary adjacent
    lines are continuations of the same sentence/paragraph.
    """
    blocks: list[str] = []
    current: list[str] = []

    def flush() -> None:
        if current:
            value = "\n".join(current).strip()
            if value:
                blocks.append(value)
            current.clear()

    for page in pages:
        for raw_line in page.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            line = re.sub(r"[ \t]+", " ", raw_line).strip()
            if not line:
                flush()
                continue
            if current and _is_explicit_heading(line):
                flush()
            if current and _is_list_item(current[-1]):
                current.append(line)
            elif current and _is_list_item(line):
                current.append(line)
            elif current:
                previous = current[-1]
                current[-1] = (
                    previous[:-1] + line
                    if re.search(r"[A-Za-z]-$", previous) and re.match(r"^[a-z]", line)
                    else previous + " " + line
                )
            else:
                current.append(line)
        # A page boundary is a safe paragraph boundary. It avoids joining the
        # last line of a page to the first line of a new visual section.
        flush()

    merged: list[str] = []
    for block in blocks:
        first_line = block.splitlines()[0].strip()
        if not merged:
            merged.append(block)
            continue
        previous = merged[-1]
        if _is_list_item(first_line):
            merged[-1] = previous + "\n" + block
        elif _is_explicit_heading(first_line):
            merged.append(block)
        elif (
            _is_explicit_heading(previous.splitlines()[0].strip())
            and len(previous.splitlines()) == 1
        ):
            merged[-1] = previous + " " + block
        elif len(previous) < 40 or len(block) < 40 or not re.search(r"[.!?]$", previous):
            # A number of PDF engines emit a blank line between every visual
            # line. Short adjacent blocks are continuations, not separate
            # factual sections.
            merged[-1] = previous + " " + block
        else:
            merged.append(block)

    return "\n\n".join(merged)


def extract(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".txt", ".md", ".csv"):
        if ext == ".csv":
            rows = csv.reader(io.StringIO(path.read_text(encoding="utf-8-sig")))
            return "\n".join(" | ".join(cell.strip() for cell in row) for row in rows)
        return path.read_text(encoding="utf-8")
    if ext == ".docx":
        with zipfile.ZipFile(path) as z:
            root = ElementTree.fromstring(z.read("word/document.xml"))
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        paragraphs = []
        for p in root.iter(ns + "p"):
            text = "".join((node.text or "") for node in p.iter(ns + "t")).strip()
            if text: paragraphs.append(text)
        return "\n\n".join(paragraphs)
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
            pages = [page.extract_text() or "" for page in PdfReader(str(path)).pages]
            text = reconstruct_pdf_text(pages)
        except Exception as exc:
            raise ValueError("PDF extraction failed: " + str(exc)) from exc
        if not text.strip():
            raise ValueError("PDF contains no extractable text (OCR is not supported)")
        return text
    raise ValueError("unsupported file type")

def _meaningful(value: str) -> bool:
    text = re.sub(r"\s+", " ", value.strip())
    # Source text must not be filtered by an arbitrary minimum length. A
    # sentence such as "Cash only." is a complete factual rule. The only
    # universally safe extraction noise to discard here is punctuation-only
    # material.
    return bool(re.search(r"[^\W_]", text, re.UNICODE))


def _split_oversized(block: str, max_chars: int) -> list[str]:
    if len(block) <= max_chars:
        return [block]
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", block)
    fragments: list[str] = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if not current:
            current = sentence
        elif len(current) + 1 + len(sentence) <= max_chars:
            current += " " + sentence
        else:
            if _meaningful(current):
                fragments.append(current)
            current = sentence
    if current and _meaningful(current):
        fragments.append(current)

    if not fragments:
        # No sentence boundary exists. Preserve every bounded piece rather
        # than silently dropping a short continuation at the end.
        return [
            piece
            for start in range(0, len(block), max_chars)
            if (piece := block[start:start + max_chars].strip()) and _meaningful(piece)
        ]

    bounded: list[str] = []
    for fragment in fragments:
        if len(fragment) <= max_chars:
            bounded.append(fragment)
        else:
            bounded.extend(
                fragment[start:start + max_chars].strip()
                for start in range(0, len(fragment), max_chars)
                if (
                    fragment[start:start + max_chars].strip()
                    and _meaningful(fragment[start:start + max_chars].strip())
                )
            )
    return bounded


def chunks(text: str, max_chars: int = 6000) -> list[dict[str, str]]:
    if max_chars < 200:
        raise ValueError("max_chars must be at least 200")
    blocks = [
        block.strip()
        for block in re.split(r"\n\s*\n+", text.replace("\r\n", "\n").replace("\r", "\n"))
        if _meaningful(block)
    ]
    bounded_blocks = [part for block in blocks for part in _split_oversized(block, max_chars)]
    out: list[dict[str, str]] = []
    pending = ""
    for block in bounded_blocks:
        candidate = f"{pending}\n\n{block}".strip() if pending else block
        if pending and len(candidate) > max_chars:
            if _meaningful(pending):
                out.append({"title": re.sub(r"^#{1,6}\s+", "", pending.splitlines()[0])[:120], "body": pending})
            pending = block
        else:
            pending = candidate
    if pending and _meaningful(pending):
        out.append({"title": re.sub(r"^#{1,6}\s+", "", pending.splitlines()[0])[:120], "body": pending})
    return out

if __name__ == "__main__":
    try:
        p = Path(sys.argv[1])
        text = extract(p)
        if not text.strip(): raise ValueError("document contains no extractable text")
        print(json.dumps({"text": text, "chunks": chunks(text)}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)