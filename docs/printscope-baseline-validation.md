# PrintScope baseline validation

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

The consultant reports an updated engine with 17 passing tests and unchanged golden records. That updated archive has not yet been received or validated here. The response additionally requires high-zoom visual verification using `-22968 B`, which is not in the supplied 13-file fixture corpus.

Do not suppress the failed test, weaken its assertion, or proceed with Hub integration while the baseline remains red.