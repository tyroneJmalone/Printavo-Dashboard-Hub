---
name: Printavo status-name matching
description: Matching pv_statuses by name requires whitespace normalization; presets must match by NAME not id.
---

Rule: when matching Printavo statuses by name (presets, rules, filters), normalize whitespace on BOTH sides (`s.replace(/\s+/g, " ").trim()`) and compare exactly — do not hardcode status ids for user-visible preset groups.

**Why:** Real status names contain stray double spaces (e.g. "Seps.io -  👕➗🧢 PARTIALLY ORDERED") and emoji; an exact string compare silently matches zero statuses. Tyler renames/reorganizes statuses in Printavo, so name-matching with a "not found" toast degrades gracefully, while hardcoded ids break silently.

**How to apply:** Any feature that groups statuses (Print Queue presets, status rules seeding) should resolve names → ids at click/eval time against the live pv_statuses list, surface partial matches to the user, and never persist resolved ids as the source of truth.

Apply the same two-sided normalization to historical status observations used
for AutoPrint re-entry eligibility. Normalizing only the observed name can
turn a known non-source status into "unknown" when the reference name has a
trailing space.

**Why:** Production history contained valid Need 2 Order → Ordered transitions
that were rejected despite recorded line changes, because the reference
Need 2 Order name ended in a space.

**How to apply:** Preserve the distinction between unknown and known non-source
statuses, and continue blocking ambiguous matches. Do not weaken re-entry or
duplicate-print safeguards to compensate for name-formatting differences.
