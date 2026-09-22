#!/usr/bin/env python3
"""Reproducibly verify private fixtures against the bundled PrintScope baseline."""
import argparse
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "printscope-engine")


def find_fixture(root, filename):
    exact = os.path.join(root, filename)
    if os.path.isfile(exact):
        return exact
    for base, _, files in os.walk(root):
        if filename in files:
            return os.path.join(base, filename)
    return None


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures", help="private fixture corpus directory")
    parser.add_argument("--golden", default=os.path.join(ENGINE, "golden"))
    args = parser.parse_args()
    fixtures = os.path.abspath(args.fixtures)
    golden = os.path.abspath(args.golden)
    manifest = json.load(open(os.path.join(golden, "MANIFEST.json"),
                              encoding="utf-8"))
    failures = []
    located = {}
    for item in manifest["fixtures"]:
        path = find_fixture(fixtures, item["filename"])
        if not path:
            failures.append(f"missing fixture: {item['filename']}")
            continue
        located[item["fixture"]] = path
        size = os.path.getsize(path)
        digest = sha256(path)
        if size != item["bytes"]:
            failures.append(f"size mismatch: {item['filename']}")
        if digest != item["sha256"]:
            failures.append(f"SHA-256 mismatch: {item['filename']}")
    if failures:
        for message in failures:
            print("FAIL", message)
        return 1

    tests = subprocess.run([sys.executable, os.path.join(ENGINE, "test_engine.py"),
                            fixtures], text=True)
    if tests.returncode:
        print("FAIL engine tests did not complete without skips")
        return 1

    sys.path.insert(0, ENGINE)
    import detect
    import extract
    import run
    table = run.load_table()
    numeric_reports = []
    for item in manifest["fixtures"]:
        expected = json.load(open(os.path.join(golden, item["golden"]),
                                  encoding="utf-8"))
        facts = extract.extract(located[item["fixture"]])
        ctx = run.build_ctx(located[item["fixture"]], facts)
        results = detect.evaluate(facts, ctx, table)
        verdict = run.overall(results)
        complete = detect.completeness(results)
        actual_status = {r["code"]: r["status"] for r in results}
        expected_status = {r["code"]: r["status"] for r in expected["results"]}
        if verdict != expected["verdict"]:
            failures.append(f"{item['fixture']}: verdict {verdict} != "
                            f"{expected['verdict']}")
        if actual_status != expected_status:
            failures.append(f"{item['fixture']}: rule statuses differ")
        for key in ("complete", "judged", "not_applicable", "cannot_evaluate",
                    "not_implemented", "errors"):
            if complete.get(key) != expected["completeness"].get(key):
                failures.append(f"{item['fixture']}: completeness.{key} differs")
        # Pixel counts can move slightly between Ghostscript builds. They are
        # diagnostic only and are deliberately not represented as byte identity.
        for ink, value in (ctx.get("coverage") or {}).items():
            old = (expected.get("ctx", {}).get("coverage", {}).get(ink) or {})
            for key in ("px", "on_base_px"):
                if key in old and value.get(key) != old[key]:
                    numeric_reports.append(
                        f"{item['fixture']} {ink} {key}: "
                        f"{old[key]} -> {value.get(key)}")
        print("PASS", item["fixture"], verdict,
              "complete=" + str(complete["complete"]).lower())
    for report in numeric_reports:
        print("NUMERIC", report)
    if numeric_reports:
        print("NOTE numeric pixel differences are reported separately; "
              "1-2px renderer variation is not byte identity")
    for message in failures:
        print("FAIL", message)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())