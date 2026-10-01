"""Read-only baseline against the bundled SHA-pinned 13-file fixture archive.

Only the eight explicitly newly implemented rows may change. Original results,
numeric context, verdict and completeness are compared without weakening their
golden assertions. The additional inspection findings are reported separately.
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
import types
import unittest

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
        # The historical renderer has pixel-level differences from the installed
        # version (e.g. 834304 vs 834303 coverage pixels on 22499). Do not call
        # those our new rules' changes. Compare all numeric context against the
        # unchanged pre-change runtime at this same renderer as well.
        old_raster = types.ModuleType("baseline_raster")
        old_run = types.ModuleType("baseline_run")
        for name, module in (("raster.py", old_raster), ("run.py", old_run)):
            source = subprocess.check_output([
                "git", "show", f"HEAD:artifacts/api-server/python/printscope-engine/{name}"], text=True)
            module.__file__ = str(HERE / name)
            exec(compile(source, module.__file__, "exec"), module.__dict__)
        old_run.RS = old_raster
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
                ctx = RUN.build_ctx(str(path), facts)
                results = DT.evaluate(facts, ctx, table)
                golden = json.loads((HERE / "golden" / fixture["golden"]).read_text())
                actual = {r["code"]: r for r in results}
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
                # Every pre-existing numeric context field remains exact at
                # the installed renderer, not merely its rounded verdict.
                serial_ctx = json.loads(json.dumps(RUN._jsonable_ctx(ctx)))
                old_ctx = old_run._jsonable_ctx(old_run.build_ctx(str(path), facts))
                for key, value in json.loads(json.dumps(old_ctx)).items():
                    self.assertEqual(serial_ctx[key], value, (fixture["filename"], key))
                self.assertEqual(
                    {r["code"] for r in results if r["status"] == DT.NOT_IMPLEMENTED}, HELD_CODES)
                self.assertNotIn("CHOKE_SAFE_FOR_DETAIL", actual)
                print(f"\n{fixture['fixture']}: new checks " +
                      ", ".join(f"{code}={actual[code]['status']}" for code in sorted(NEW_CODES)),
                      flush=True)
            proc = subprocess.run([sys.executable, str(HERE / "test_engine.py"), tmp],
                                  text=True, capture_output=True, timeout=300)
            print(proc.stdout, flush=True)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()