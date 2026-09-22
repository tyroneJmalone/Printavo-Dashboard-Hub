import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "printscope_worker.py")
spec = importlib.util.spec_from_file_location("printscope_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerBoundaryTests(unittest.TestCase):
    def _validate_synthetic_result(self, completeness, previews):
        with tempfile.TemporaryDirectory() as root:
            site = os.path.join(root, "site")
            os.mkdir(site)
            generated = os.path.join(root, "engine.json")
            rec = {
                "facts": {"artboard_count": 1,
                          "artboards": [{"paint_ops": 1}]},
                "results": [],
                "completeness": completeness,
                "previews": previews,
            }
            with open(generated, "w", encoding="utf-8") as fh:
                json.dump(rec, fh)
            result, assets = worker._validate_result(rec, root, generated)
            self.assertEqual(assets, site)
            with open(result, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), rec)

    def test_requires_absolute_paths(self):
        with self.assertRaises(worker.WorkerError):
            worker._regular_file("source.ai", "input", 10, ".ai")

    def test_rejects_non_pdf_ai(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "bad.ai")
            with open(path, "wb") as fh:
                fh.write(b"not a PDF")
            class FakePike:
                class Pdf:
                    pass
            with self.assertRaisesRegex(worker.WorkerError, "PDF-compatible"):
                worker._validate_pdf(path, FakePike)

    def test_output_must_be_empty(self):
        with tempfile.TemporaryDirectory() as root:
            open(os.path.join(root, "occupied"), "w").close()
            with self.assertRaisesRegex(worker.WorkerError, "empty"):
                worker._output_dir(root)

    def test_cli_error_uses_stderr_only(self):
        proc = subprocess.run([sys.executable, WORKER], capture_output=True,
                              text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertIn("required", proc.stderr)

    def test_preserves_engine_completeness_errors(self):
        self._validate_synthetic_result(
            {"complete": False, "errors": 1,
             "unverified": ["RULE: detector failed"]},
            [])

    def test_preserves_preview_choke_warning(self):
        self._validate_synthetic_result(
            {"complete": True, "errors": 0, "unverified": []},
            [{"index": 1, "plates": [],
              "choke_failed": ["Ink: composed plate was invalid"]}])

    def test_probe_contract_when_available(self):
        proc = subprocess.run([sys.executable, WORKER, "--probe"],
                              capture_output=True, text=True)
        if proc.returncode:
            self.skipTest(proc.stderr.strip())
        value = json.loads(proc.stdout)
        self.assertEqual(set(value), {"available", "engineVersion", "measureDpi",
                                     "ghostscript", "mupdf"})
        self.assertTrue(value["available"])
        self.assertEqual(value["measureDpi"], 200)


if __name__ == "__main__":
    unittest.main()