# PrintScope worker

Use the project's Python interpreter and dependencies directly; do not create a
second virtual environment. The Python packages are pinned in
`printscope-engine/requirements.txt`, and Ghostscript (`gs`) and MuPDF
(`mutool`) must be on `PATH`.

Capability check:

```sh
python3 artifacts/api-server/python/printscope_worker.py --probe
```

Success is one JSON line with `available`, `engineVersion`, `measureDpi`,
`ghostscript`, and `mupdf`. Errors are written to stderr and exit nonzero.

Inspection:

```sh
mkdir /private/tmp/job-123
python3 artifacts/api-server/python/printscope_worker.py \
  --input "/absolute/private/source.ai" \
  --output-dir "/private/tmp/job-123" \
  --rules "$PWD/artifacts/api-server/python/printscope-engine/printscope-rules-v2.csv"
```

The output directory must already exist and be empty. Success writes
`result.json`, assets below `site/`, and prints exactly one JSON line:
`{"resultPath":".../result.json","assetsRoot":".../site"}`. The caller must
enforce a wall-clock timeout, supply a sanitized environment, and monitor the
whole process family's actual RSS (terminating it at the service aggregate
memory limit). The worker also sets a hard 2 GiB `RLIMIT_AS` before importing
numpy/scipy, after forcing numerical libraries to one thread. Children inherit
that limit, but it is a **per-process address-space limit**, not an aggregate
family-memory limit; the caller's watchdog is still required. The probe fails
nonzero if the platform cannot enforce this limit. Never serve the private
fixture corpus.

An engine result with `completeness.complete=false`, detector `errors`, or
`previews[].choke_failed` is still a successful worker result. Those fields are
evidence the UI must display, not wrapper failures to discard. The wrapper
rejects malformed structures and unsafe output paths, but preserves the engine
JSON unchanged.

Boundary tests:

```sh
python3 -m unittest artifacts/api-server/python/test_printscope_worker.py
```

Reproducible baseline verification (intentionally expensive, not a boot check):

```sh
python3 artifacts/api-server/python/verify_baseline.py /absolute/private/fixtures
```

This verifies fixture size/SHA-256 before running the 17 tests with no skips,
then independently compares every bundled golden verdict, rule status, and
completeness field. Renderer-dependent pixel-count changes are reported
separately and are not claimed to be byte-identical.