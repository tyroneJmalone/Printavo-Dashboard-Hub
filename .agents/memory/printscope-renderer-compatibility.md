---
name: PrintScope renderer compatibility
description: MuPDF SVG dimension formatting can silently suppress the calibrated choke mask.
---

Treat renderer-version compatibility as part of PrintScope's baseline, not just dependency installation.

**Why:** The supplied engine was validated against MuPDF 1.23.10. MuPDF 1.25.3 emits unitless SVG dimensions where the older engine expects `pt`. The mask composer can return the original plate without a choke mask even while all 13 golden verdict/status/completeness comparisons match. Thus correct numeric verdicts do not prove previews are correct.

**How to apply:** Preserve measurement settings and recolour-before-compose order. Require the choke-mask test and visual verification to pass when changing renderers or porting the engine. Consult `docs/printscope-baseline-validation.md` for the baseline evidence; do not weaken tests to accept an unmasked plate.

Preserve the source SVG root dimensions and units rather than accepting unitless inputs and emitting hardcoded `pt` units.

**Why:** The consultant identified that the proposed optional-unit regex alone would convert unitless widths into point widths, changing intrinsic scale by 4/3. The consultant also reports a second point-only size parser in preview metadata that disables artwork-centered zoom. These corrections must be validated against the supplied updated engine, not inferred from its release note.

**How to apply:** Check mask composition and preview-size parsing together. Verify consistent base/color alignment and artwork-centered zoom, as well as explicit disclosure of any unchoked fallback. Numerical golden matches alone cannot establish preview correctness.