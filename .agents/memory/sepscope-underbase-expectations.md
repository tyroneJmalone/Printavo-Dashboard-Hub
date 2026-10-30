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

Earlier Pass results must not authorize archive/task completion after a
materially stronger coverage detector is introduced; retain their history
and require explicit reinspection.

**Why:** A stored Pass can be a known false negative under the old detector.
Changing code alone does not change that stored evidence.

**How to apply:** Bind action eligibility to current detector evidence, without
silently rewriting old inspections or automatically releasing their actions.
