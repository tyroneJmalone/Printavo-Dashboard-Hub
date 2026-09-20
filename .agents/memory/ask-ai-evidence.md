---
name: Ask AI evidence boundaries
description: Keep database evidence separate from model explanations, especially dates and duration arithmetic.
---

Keep provenance facts and AI explanations distinct. Request combined totals and duration averages from SQL rather than asking the model to calculate them from grouped results; prefer numeric hours/days over PostgreSQL interval objects.

**Why:** A live status-duration question produced a model-calculated weighted average from interval objects with hour components above 24. It also renamed deliberate coverage bounds, making an exact-name-only extractor miss valid evidence. These are reasons to expose query evidence, not to label the narrative independently verified.

**How to apply:** Recognize deliberate coverage-bound aliases without combining arbitrary due/creation/sync dates into a fictitious window. Validate finding references and copied values, but do not treat those as proof of the narrative. Avoid regex-based SQL-semantic or numeric-claim blockers: they reject legitimate outer filters, rounding, and formatted dates without proving correctness.