"""Deterministic, offline text extraction for knowledge source ingestion."""
from __future__ import annotations
import csv, io, json, re, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree

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
            text = "\n\n".join((page.extract_text() or "").strip() for page in PdfReader(str(path)).pages)
        except Exception as exc:
            raise ValueError("PDF extraction failed: " + str(exc)) from exc
        if not text.strip():
            raise ValueError("PDF contains no extractable text (OCR is not supported)")
        return text
    raise ValueError("unsupported file type")

def chunks(text: str, max_chars: int = 1800) -> list[dict[str, str]]:
    blocks = [re.sub(r"[ \t]+", " ", x.strip()) for x in re.split(r"\n\s*\n+", text) if x.strip()]
    out = []
    for block in blocks:
        parts = re.split(
            r"^(?=#{1,6}\s)|^(?=[A-Z][A-Za-z0-9 /&'_-]{2,80}:?\s*$)",
            block,
            flags=re.MULTILINE,
        )
        for part in parts:
            part = part.strip()
            if not part: continue
            for start in range(0, len(part), max_chars):
                body = part[start:start + max_chars].strip()
                if body:
                    out.append({"title": body.splitlines()[0][:120], "body": body})
                    if len(out) >= 60:
                        return out
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