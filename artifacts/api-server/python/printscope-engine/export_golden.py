"""Export the verdicts this engine produces, as a baseline to port against.

Writes, for each fixture the golden tests depend on:

  golden/<slug>.json      the full result with previews stripped
  golden/MANIFEST.json    fixture list with sizes and content hashes

The manifest is the important half. It pins each fixture to the exact bytes
these verdicts were produced from, so a port can prove it is comparing like
with like rather than against a file that has since been resaved.

Run:  python3 export_golden.py [path/to/corpus]
"""
import glob, hashlib, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as CFG
import detect as DT
import extract as EX
import run as RUN

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "golden")

CORPUS = (sys.argv[1] if len(sys.argv) > 1
          else os.environ.get("PRINTSCOPE_CORPUS", "/mnt/user-data/uploads/PrintScope"))

# Every file the golden tests reach for. Stems only - the invoice prefix
# changed from '#' to '-' partway through 2026 and both appear in the corpus.
FIXTURES = [
    "22499 F", "21825 F1", "22554 F", "22541 B REVISED", "22583 B",
    "22591 F", "22617 B", "11302 B", "22560 B",
    "22906 LC OUTPUT 1", "22906 LC OUTPUT 2", "22717 B", "22771 LC",
]


def find(stem):
    for pat in (f"{stem}.ai", f"{stem} OUTPUT.ai", f"{stem} OUTPUT*.ai"):
        for pre in ("#", "-", ""):
            hits = sorted(glob.glob(os.path.join(CORPUS, pre + pat)))
            if hits:
                return hits[0]
    return None


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def main():
    os.makedirs(OUT, exist_ok=True)
    table = RUN.load_table()
    manifest = {
        "engine_version": CFG.ENGINE_VERSION,
        "rules_version": RUN.rules_version(),
        "measure_dpi": CFG.MEASURE_DPI,
        "based_ink_pct": CFG.BASED_INK_PCT,
        "note": ("Verdicts below were produced by this engine at these settings. "
                 "A port should reproduce them exactly. Measurement settings are "
                 "listed because the trap thresholds are calibrated to them."),
        "fixtures": [],
    }

    missing = []
    for stem in FIXTURES:
        path = find(stem)
        if not path:
            missing.append(stem)
            continue

        facts = EX.extract(path)
        ctx = RUN.build_ctx(path, facts)
        results = DT.evaluate(facts, ctx, table)
        comp = DT.completeness(results)

        rec = {
            "fixture": stem,
            "filename": os.path.basename(path),
            "sha256": sha256(path),
            "bytes": os.path.getsize(path),
            "verdict": RUN.overall(results),
            "completeness": comp,
            "results": [{k: r[k] for k in
                         ("code", "status", "severity", "headline", "data")}
                        for r in results],
            "adjacency": ctx.get("adjacency", {}),
            "ctx": RUN._jsonable_ctx(ctx),
        }
        slug = "".join(c if c.isalnum() else "_" for c in stem)
        with open(os.path.join(OUT, slug + ".json"), "w") as fh:
            json.dump(rec, fh, indent=2, sort_keys=True)

        manifest["fixtures"].append({
            "fixture": stem, "filename": rec["filename"],
            "sha256": rec["sha256"], "bytes": rec["bytes"],
            "verdict": rec["verdict"], "complete": comp["complete"],
            "golden": slug + ".json",
        })
        print(f"{rec['verdict'].upper():5} {rec['filename']:34} "
              f"{'complete' if comp['complete'] else 'INCOMPLETE'}")

    if missing:
        manifest["missing_fixtures"] = missing
        print("\nMISSING from the corpus: " + ", ".join(missing))

    with open(os.path.join(OUT, "MANIFEST.json"), "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
    print(f"\n{len(manifest['fixtures'])} fixtures exported to {OUT}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
