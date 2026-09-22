# PrintScope baseline validation

## Updated engine validation

The supplied engine 0.4.1 was tested with MuPDF 1.25.3 and Ghostscript 10.05.1.

- All 13 supplied fixture SHA-256 hashes and byte sizes match.
- All 13 overall verdicts, per-rule statuses, and completeness objects match.
- Five full JSON records differ only in raw `ctx.coverage` pixel counts by one or two pixels. Do not describe the records as byte-identical in this environment; the required verdict/status/completeness comparisons are unchanged.
- The unmodified suite reports **16 passed, 1 failed, 0 skipped**: its new dual-format test assumes native renderer output is point-suffixed, so its first case is falsely labelled `pt` on the newer renderer.
- Corrected only the test's fixture construction to explicitly create both dimension spellings in the SVG opening tag. All mask/header/body/error assertions are retained. The corrected suite reports **17 passed, 0 failed, 0 skipped**.
- The supplied runtime engine files are unchanged. Independent probes confirm header units preserved, white mask background, black knockout strokes, identical mask/body for the two constructed formats, and explicit malformed-header failure.

### Browser evidence

Generated the reference viewer from `-22906 LC OUTPUT 1.ai` and inspected it in Chromium, All stacked, 1600% zoom. With colour at 30% and base at 100%, the screenshot shows the magenta base inset within a thin pale-green perimeter along visible straight and curved edges. The image provides visual evidence of the requested choke/overlay relationship, not a quantitative area measurement or proof of every edge.

The browser-testing agent conservatively reported the edge relationship as inconclusive; the main reviewer inspected its captured image and observed the inset described above. Do not claim a machine-measured 7–8% area reduction. Browser evidence reference: screenshot `hc32wi` in the validation conversation (not a persistent project artifact). Offline MuPDF/Cairo rasterization was not used to judge the SVG mask.

## Manual Hub integration acceptance

- The genuine 13-file corpus passed the complete development flow: signed private upload, verified immutable original, queued Python processing, durable result, and authenticated plate serving.
- All 13 verdicts, 481 rule statuses, and every completeness object matched the supplied golden expectations. All 43 generated private plate URLs returned image bytes.
- Re-inspection created a separate job with the same original generation; the prior result remained unchanged. A cross-job plate request returned 404.
- Ten backend boundary tests and seven Python wrapper tests passed. Hub and API type checks passed.
- The wrapper preserves detector errors, incomplete evaluations, and choke-failure warnings inside completed engine results rather than discarding that evidence.
- The registration-tolerance test was also strengthened using an explicit 0.01pt injected delta and 0.005pt / 0.02pt fail/pass thresholds. Runtime measurement code is unchanged.
- The running API returned 401 for an unauthenticated PrintScope request and 200 for health. The actual Hub browser preview reached the staff sign-in screen; authenticated Hub interaction/layout was not browser-tested, and no verification email was triggered.
- The reproducible service integration harness is `artifacts/api-server/test-printscope-integration.mjs`. It uses isolated test-only staff middleware, real development storage/database, and exact-ID cleanup. No bypass was added to the application.
- Printavo intake, the shadow run, external renames/status changes, and automatic retention deletion remain outside this manual-only release.

## Historical initial-engine validation

## Scope

Executed the supplied engine unchanged in a temporary directory against the supplied confidential fixtures. No Hub module, database tables, routes, Printavo intake, or external write actions have been added.

Dependencies are recorded in the workspace Python package files and system configuration.

## Results

- All 13 fixture hashes and byte sizes match the supplied manifest.
- All 13 reproduced overall verdicts, per-rule statuses, and completeness objects match the supplied golden JSON.
- The unchanged behavioral suite reports **15 passed, 1 failed, 0 skipped**.
- Failure: **knockout mask survives recolour**.
- The acceptance gate of 16 passed, zero failed, zero skipped is therefore not satisfied.
- Full visual preview verification has not been completed.

## Confirmed cause

The consultant verified MuPDF 1.23.10. The installed renderer is MuPDF 1.25.3. It produces SVG roots with unitless dimensions:

```xml
width="1152" height="216" viewBox="0 0 1152 216"
```

The supplied `vector.py` dimension matcher requires explicit `pt` suffixes:

```python
WH = re.compile(r'width="([\d.]+)pt"\s+height="([\d.]+)pt"\s+viewBox="([^"]+)"')
```

When this does not match, `compose_knockout` returns the plate unchanged. Direct inspection confirmed the plate and knockout SVG both exist, but the composed output has no mask element. This is a real missing-mask defect, not just a test string mismatch, and it can make the preview show an unchoked plate.

Ghostscript is 10.05.1 (the consultant recorded 10.02.1). Despite that difference, the required golden verdict/status/completeness comparisons match.

## Proposed next action

The initial optional-unit regex proposal is superseded by consultant review. It was not applied. Accepting unitless input while retaining hardcoded `pt` output would change intrinsic scale. Preserve the original SVG opening tag and use its viewBox for mask geometry instead. The consultant also reports a second point-only size parser in `run.py` that must be corrected to preserve artwork-centered zoom.

The consultant subsequently supplied the updated engine and corrected the acceptance fixture to `-22906 LC OUTPUT 1.ai`, already in the supplied corpus. See the updated validation above.

Do not suppress the failed test, weaken its assertion, or proceed with Hub integration while the baseline remains red.