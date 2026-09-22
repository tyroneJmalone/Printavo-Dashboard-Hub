---
name: PrintScope renderer compatibility
description: MuPDF SVG dimension formatting can silently suppress the calibrated choke mask.
---

Treat renderer-version compatibility as part of PrintScope's baseline, not just dependency installation.

**Why:** The supplied engine was validated against MuPDF 1.23.10. MuPDF 1.25.3 emits unitless SVG dimensions where the older engine expects `pt`. The mask composer can return the original plate without a choke mask even while all 13 golden verdict/status/completeness comparisons match. Thus correct numeric verdicts do not prove previews are correct.

**How to apply:** Preserve measurement settings and recolour-before-compose order. Require the choke-mask test and visual verification to pass when changing renderers or porting the engine. Consult `docs/printscope-baseline-validation.md` for the baseline evidence; do not weaken tests to accept an unmasked plate.