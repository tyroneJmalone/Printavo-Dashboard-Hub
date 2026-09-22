#!/usr/bin/env python3
"""Constrained process boundary for the PrintScope reference engine."""
import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

MAX_INPUT_BYTES = 50 * 1024 * 1024
MAX_RULES_BYTES = 5 * 1024 * 1024
MAX_PAGES = 20
MAX_PDF_OBJECTS = 500_000
MAX_PAINT_OPS = 1_000_000
MAX_RESULT_BYTES = 12 * 1024 * 1024
MAX_ASSET_BYTES = 12 * 1024 * 1024
MAX_ASSETS_BYTES = 120 * 1024 * 1024
MAX_ASSET_FILES = 500
MAX_ADDRESS_SPACE_BYTES = 2 * 1024 * 1024 * 1024
MEASURE_DPI = "200"
BASED_INK_PCT = "85"
ENGINE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "printscope-engine")


class WorkerError(RuntimeError):
    pass


def _regular_file(path, label, maximum, suffix=None):
    if not os.path.isabs(path):
        raise WorkerError(f"{label} path must be absolute")
    if suffix and not path.lower().endswith(suffix):
        raise WorkerError(f"{label} must have a {suffix} extension")
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        raise WorkerError(f"cannot access {label}: {exc}") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise WorkerError(f"{label} must be a regular, non-symlink file")
    if info.st_size <= 0 or info.st_size > maximum:
        raise WorkerError(f"{label} size must be between 1 and {maximum} bytes")
    return os.path.realpath(path)


def _output_dir(path):
    if not os.path.isabs(path):
        raise WorkerError("output directory path must be absolute")
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        raise WorkerError(f"cannot access output directory: {exc}") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise WorkerError("output directory must be a real, non-symlink directory")
    root = os.path.realpath(path)
    if os.listdir(root):
        raise WorkerError("output directory must be empty")
    return root


def _inside(root, path):
    return os.path.commonpath((root, os.path.realpath(path))) == root


def _set_limits():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (240, 245))
        resource.setrlimit(resource.RLIMIT_FSIZE,
                           (MAX_ASSETS_BYTES, MAX_ASSETS_BYTES))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        if not hasattr(resource, "RLIMIT_AS"):
            raise WorkerError("this platform cannot enforce an address-space limit")
        _, current_hard = resource.getrlimit(resource.RLIMIT_AS)
        address_cap = MAX_ADDRESS_SPACE_BYTES
        if current_hard != resource.RLIM_INFINITY:
            address_cap = min(address_cap, current_hard)
        resource.setrlimit(resource.RLIMIT_AS, (address_cap, address_cap))
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        if soft > MAX_ADDRESS_SPACE_BYTES or hard > MAX_ADDRESS_SPACE_BYTES:
            raise WorkerError("address-space limit was not enforced")
    except WorkerError:
        raise
    except (ImportError, OSError, ValueError) as exc:
        raise WorkerError(
            f"required process resource limits unavailable: {exc}") from None


def _configure(output, rules):
    env = {
        "PRINTSCOPE_RULES": rules,
        "PRINTSCOPE_QUEUE": output,
        "PRINTSCOPE_SITE": os.path.join(output, "site"),
        "PRINTSCOPE_MEASURE_DPI": MEASURE_DPI,
        "PRINTSCOPE_BASED_INK_PCT": BASED_INK_PCT,
        "PRINTSCOPE_FALLBACK_DPI": "600",
        "PRINTSCOPE_SVG_MAX_BYTES": "2500000",
        "TMPDIR": os.path.join(output, "tmp"),
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
        "VECLIB_MAXIMUM_THREADS": "1",
    }
    os.makedirs(env["TMPDIR"], mode=0o700)
    os.makedirs(env["PRINTSCOPE_SITE"], mode=0o700)
    os.environ.update(env)
    tempfile.tempdir = env["TMPDIR"]


def _load_engine():
    sys.path.insert(0, ENGINE_DIR)
    import pikepdf
    import config as cfg
    import extract
    import run
    import vector
    return pikepdf, cfg, extract, run, vector


def _validate_pdf(src, pikepdf):
    with open(src, "rb") as fh:
        if fh.read(5) != b"%PDF-":
            raise WorkerError("input is not a PDF-compatible Illustrator file")
    try:
        with pikepdf.Pdf.open(src) as pdf:
            pages = len(pdf.pages)
            if not 1 <= pages <= MAX_PAGES:
                raise WorkerError(f"PDF page count {pages} is outside 1..{MAX_PAGES}")
            if len(pdf.objects) > MAX_PDF_OBJECTS:
                raise WorkerError("PDF object count exceeds safety limit")
            for page in pdf.pages:
                box = page.get("/MediaBox")
                if box is None or len(box) != 4:
                    raise WorkerError("PDF page has no valid MediaBox")
                width = abs(float(box[2]) - float(box[0]))
                height = abs(float(box[3]) - float(box[1]))
                if width <= 0 or height <= 0 or width > 14_400 or height > 14_400:
                    raise WorkerError("PDF page geometry exceeds safety limit")
    except WorkerError:
        raise
    except Exception as exc:
        raise WorkerError(f"input PDF could not be safely parsed: {exc}") from None


def _validate_result(rec, output, generated_path):
    if not isinstance(rec, dict) or not isinstance(rec.get("results"), list):
        raise WorkerError("engine returned an invalid result")
    facts = rec.get("facts") or {}
    if facts.get("artboard_count", 0) > MAX_PAGES:
        raise WorkerError("engine artboard count exceeds safety limit")
    paint = sum(int(ab.get("paint_ops", 0)) for ab in facts.get("artboards", []))
    if paint > MAX_PAINT_OPS:
        raise WorkerError("artwork object count exceeds safety limit")
    comp = rec.get("completeness")
    if not isinstance(comp, dict):
        raise WorkerError("engine result has no completeness record")

    if not _inside(output, generated_path):
        raise WorkerError("engine result escaped the output directory")
    result_path = os.path.join(output, "result.json")
    if os.path.realpath(generated_path) != result_path:
        os.replace(generated_path, result_path)
    size = os.path.getsize(result_path)
    if size > MAX_RESULT_BYTES:
        raise WorkerError("result JSON exceeds safety limit")
    with open(result_path, encoding="utf-8") as fh:
        json.load(fh)

    site = os.path.join(output, "site")
    for preview in rec.get("previews", []):
        for plate in preview.get("plates", []):
            rel = plate.get("src")
            if not isinstance(rel, str) or os.path.isabs(rel):
                raise WorkerError("result contains an unsafe asset reference")
            asset = os.path.join(site, rel)
            if not _inside(site, asset) or not os.path.isfile(asset):
                raise WorkerError("result references a missing or unsafe asset")
    total = count = 0
    for base, dirs, files in os.walk(site, followlinks=False):
        for name in dirs + files:
            path = os.path.join(base, name)
            if os.path.islink(path) or not _inside(site, path):
                raise WorkerError("generated asset contains an unsafe path")
        for name in files:
            path = os.path.join(base, name)
            info = os.stat(path, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ASSET_BYTES:
                raise WorkerError("generated asset exceeds safety limit")
            count += 1
            total += info.st_size
            if count > MAX_ASSET_FILES or total > MAX_ASSETS_BYTES:
                raise WorkerError("generated asset set exceeds safety limit")
    return result_path, site


def run_job(args):
    src = _regular_file(args.input, "input", MAX_INPUT_BYTES, ".ai")
    rules = _regular_file(args.rules, "rules", MAX_RULES_BYTES, ".csv")
    output = _output_dir(args.output_dir)
    _configure(output, rules)
    _set_limits()
    pikepdf, _, _, runner, _ = _load_engine()
    _validate_pdf(src, pikepdf)
    table = runner.load_table()
    if not table:
        raise WorkerError("rules table is empty")
    rec, generated = runner.process(src, table)
    result_path, site = _validate_result(rec, output, generated)
    return {"resultPath": result_path, "assetsRoot": site}


def _version(command, pattern=None):
    try:
        proc = subprocess.run(command, check=True, capture_output=True, text=True,
                              timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        raise WorkerError(f"{command[0]} is unavailable: {exc}") from None
    text = (proc.stdout + "\n" + proc.stderr).strip()
    if pattern:
        match = re.search(pattern, text, re.I)
        return match.group(1) if match else text.splitlines()[0][:120]
    return text.splitlines()[0][:120]


def _tiny_pdf(path):
    body = b"0 0 1 rg 12 12 48 36 re f\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] "
        b"/Resources << >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n%sendstream" % (len(body), body),
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(out)
    out.extend(f"xref\n0 {len(objects)+1}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode())
    out.extend(f"trailer << /Size {len(objects)+1} /Root 1 0 R >>\n"
               f"startxref\n{xref}\n%%EOF\n".encode())
    with open(path, "wb") as fh:
        fh.write(out)


def run_probe():
    work = tempfile.mkdtemp(prefix="printscope_probe_")
    rules = os.path.join(ENGINE_DIR, "printscope-rules-v2.csv")
    _configure(work, rules)
    _set_limits()
    pikepdf, cfg, _, _, vector = _load_engine()
    pdf = os.path.join(work, "probe.pdf")
    _tiny_pdf(pdf)
    _validate_pdf(pdf, pikepdf)
    ghostscript = _version([cfg.GS_BIN, "--version"])
    mupdf = _version([cfg.MUTOOL_BIN, "-v"], r"version\s+([^\s]+)")
    gs_png = os.path.join(work, "gs.png")
    try:
        subprocess.run([cfg.GS_BIN, "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE",
                        "-sDEVICE=pnggray", "-r72", f"-sOutputFile={gs_png}", pdf],
                       check=True, capture_output=True, timeout=20)
        subprocess.run([cfg.MUTOOL_BIN, "draw", "-F", "svg", "-o",
                        os.path.join(work, "page.svg"), pdf, "1"],
                       check=True, capture_output=True, timeout=20)
    except subprocess.SubprocessError as exc:
        raise WorkerError(f"renderer capability check failed: {exc}") from None
    hits = [os.path.join(work, n) for n in os.listdir(work)
            if n.startswith("page") and n.endswith(".svg")]
    if not os.path.isfile(gs_png) or not hits:
        raise WorkerError("renderer did not produce probe output")
    svg = open(hits[0], encoding="utf-8").read()
    ET.fromstring(svg)
    if not vector.SVG_OPEN.search(svg) or not vector.VIEWBOX.search(svg):
        raise WorkerError("MuPDF SVG has no parseable dimensions")
    header = '<svg width="72pt" height="72pt" viewBox="0 0 72 72">'
    plate = header + '<path fill="#112233" d="M1 1h20v20z"/></svg>'
    knockout = header + '<path stroke="#ffffff" d="M2 2h10"/></svg>'
    composed = vector.compose_knockout(plate, knockout)
    if not composed.startswith(header) or "<mask" not in composed or \
            'stroke="#000000"' not in composed or not vector.is_well_formed(composed):
        raise WorkerError("knockout composition capability check failed")
    return {"available": True, "engineVersion": cfg.ENGINE_VERSION,
            "measureDpi": int(cfg.MEASURE_DPI), "ghostscript": ghostscript,
            "mupdf": mupdf}


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--rules")
    args = parser.parse_args()
    try:
        if args.probe:
            if args.input or args.output_dir or args.rules:
                raise WorkerError("--probe does not accept job arguments")
            answer = run_probe()
        else:
            if not all((args.input, args.output_dir, args.rules)):
                raise WorkerError("--input, --output-dir, and --rules are required")
            answer = run_job(args)
        sys.stdout.write(json.dumps(answer, separators=(",", ":")) + "\n")
        return 0
    except Exception as exc:
        message = str(exc).replace("\n", " ").strip() or type(exc).__name__
        sys.stderr.write(f"printscope worker: {message[:1000]}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())