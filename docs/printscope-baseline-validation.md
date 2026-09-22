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

Discuss a narrow compatibility correction with the user because the handoff explicitly protects the PDF modules from changes: accept both unitless and point-suffixed SVG dimensions without changing geometry, measurement DPI, recolour/composition order, or rule thresholds. Add a focused regression for both forms and for unsupported dimensions, then rerun the baseline suite and inspect the preview.

Do not suppress the failed test, weaken its assertion, or proceed with Hub integration while the baseline remains red.