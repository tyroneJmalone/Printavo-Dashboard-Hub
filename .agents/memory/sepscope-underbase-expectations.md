---
name: SepScope localized underbase defects
description: Expected behavior for deliberately removed portions of underbase
---
The user expects missing underbase beneath a portion of an otherwise based
ink to fail inspection, including a missing word in a small tagline.

**Why:** They deliberately removed the base beneath “hardscape” in the E&D
Landscaping artwork as a negative test; a high whole-ink coverage percentage
does not meet that expectation.

**How to apply:** Evaluate localized missing coverage, distinguishing intentional
choke/spread edges from missing interior regions. Do not treat simply raising
an overall coverage percentage to 100% as a validated fix.
