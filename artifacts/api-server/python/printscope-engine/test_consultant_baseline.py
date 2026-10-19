"""Read-only baseline against the bundled SHA-pinned 13-file fixture archive.

Historical results are checked using whole-plate coverage. The info-bar patch
is compared against that measurement on the same renderer; only the known
22771 LC coverage verdict may change. Additional Hub checks remain enabled.
The fixture archive and golden JSON are never rewritten.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from functools import lru_cache
from unittest.mock import patch
import raster as RS

import detect as DT
import extract as EX
import run as RUN
from test_consultant_rules import NEW_CODES, HELD_CODES


HERE = Path(__file__).resolve().parent
ARCHIVE = HERE.parents[3] / "attached_assets" / "printscope-fixtures.tar_1790107096105.gz"


class GoldenBaselineTests(unittest.TestCase):
    def test_pinned_corpus_and_original_behavior_suite(self):
        manifest = json.loads((HERE / "golden" / "MANIFEST.json").read_text())
        table = RUN.load_table()
        # Compare corrected and whole-plate measurements on this same renderer,
        # independently of historical renderer pixel-level differences.
        with tempfile.TemporaryDirectory(prefix="sepscope-baseline-") as tmp, tarfile.open(ARCHIVE) as archive:
            members = {Path(member.name).name: member for member in archive.getmembers() if member.isfile()}
            for fixture in manifest["fixtures"]:
                payload = archive.extractfile(members[fixture["filename"]]).read()
                self.assertEqual(len(payload), fixture["bytes"])
                self.assertEqual(hashlib.sha256(payload).hexdigest(), fixture["sha256"])
                # Private temporary test copy, never the archive or source art.
                path = Path(tmp) / fixture["filename"]
                path.write_bytes(payload)
                facts = EX.extract(str(path))
                # Compare against the same engine measuring whole plates.
                # This remains reproducible after commits, unlike git HEAD.
                # Rasterization is deterministic; share plates within this
                # fixture, then release them to bound test memory usage.
                with patch.object(RS, "plates", lru_cache(maxsize=4)(RS.plates)):
                    ctx = RUN.build_ctx(str(path), facts)
                    with patch.object(RS, "info_bar_cut", return_value=None):
                        old_ctx = RUN.build_ctx(str(path), facts)
                results = DT.evaluate(facts, ctx, table)
                before = {r["code"]: r for r in DT.evaluate(facts, old_ctx, table)}
                changed = [r["code"] for r in results
                           if r["status"] != before[r["code"]]["status"]]
                expected = ["UNDERBASE_COVERAGE"] if fixture["filename"] == "-22771 LC OUTPUT.ai" else []
                self.assertEqual(changed, expected, fixture["filename"])
                if expected:
                    self.assertEqual(before["UNDERBASE_COVERAGE"]["status"], DT.FLAG)
                    self.assertEqual(next(r for r in results if r["code"] == "UNDERBASE_COVERAGE")["status"], DT.PASS)
                for key, value in old_ctx.items():
                    if key not in {"coverage", "based_inks", "coverage_bar_cut_px",
                                   "register_pair", "erosion"}:
                        self.assertEqual(ctx[key], value, (fixture["filename"], key))
                self.assertEqual(ctx.get("register_pair"), old_ctx.get("register_pair"))
                if expected:
                    self.assertEqual(set(ctx["based_inks"]) - set(old_ctx["based_inks"]),
                                     {"5-230-Brown 7518 C"})
                    self.assertFalse(set(old_ctx["based_inks"]) - set(ctx["based_inks"]))
                    # More based ink means more shapes examined, not newly
                    # vanished shapes. Pin the observed local-renderer result.
                    self.assertEqual(old_ctx["erosion"], {
                        "components_before": 128, "components_after": 404,
                        "vanished": 0, "choke_px": 1})
                    self.assertEqual(ctx["erosion"], {
                        "components_before": 146, "components_after": 519,
                        "vanished": 0, "choke_px": 1})
                else:
                    self.assertEqual(ctx.get("erosion"), old_ctx.get("erosion"))
                golden = json.loads((HERE / "golden" / fixture["golden"]).read_text())
                actual = before
                # Historical goldens predate the explanatory coverage footer.
                coverage = actual["UNDERBASE_COVERAGE"]
                if coverage["detail"] and coverage["detail"][-1].startswith("The info bar could not"):
                    coverage["detail"] = coverage["detail"][:-1]
                prior_results = []
                for old in golden["results"]:
                    now = actual[old["code"]]
                    if old["code"] in NEW_CODES:
                        self.assertEqual(old["status"], DT.NOT_IMPLEMENTED)
                        self.assertNotIn(now["status"], (DT.ERROR, DT.NOT_IMPLEMENTED))
                        prior_results.append(dict(now, **old))
                    else:
                        self.assertEqual(
                            json.loads(json.dumps({k: now[k] for k in old})),
                            old, (fixture["filename"], old["code"]))
                        prior_results.append(now)
                self.assertEqual(DT.completeness(prior_results), golden["completeness"])
                self.assertEqual(RUN.overall(prior_results), golden["verdict"])
                self.assertEqual(
                    {r["code"] for r in results if r["status"] == DT.NOT_IMPLEMENTED}, HELD_CODES)
                self.assertNotIn("CHOKE_SAFE_FOR_DETAIL", actual)
                print(f"\n{fixture['fixture']}: new checks " +
                      ", ".join(f"{code}={actual[code]['status']}" for code in sorted(NEW_CODES)),
                      flush=True)
            proc = subprocess.run([sys.executable, str(HERE / "test_engine.py"), tmp],
                                  text=True, capture_output=True, timeout=600)
            print(proc.stdout, flush=True)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()