---
name: Printavo status-name matching
description: Matching pv_statuses by name requires whitespace normalization; presets must match by NAME not id.
---

Rule: when matching Printavo statuses by name (presets, rules, filters), normalize whitespace on BOTH sides (`s.replace(/\s+/g, " ").trim()`) and compare exactly — do not hardcode status ids for user-visible preset groups.

**Why:** Real status names contain stray double spaces (e.g. "Seps.io -  👕➗🧢 PARTIALLY ORDERED") and emoji; an exact string compare silently matches zero statuses. Tyler renames/reorganizes statuses in Printavo, so name-matching with a "not found" toast degrades gracefully, while hardcoded ids break silently.

**How to apply:** Any feature that groups statuses (Print Queue presets, status rules seeding) should resolve names → ids at click/eval time against the live pv_statuses list, surface partial matches to the user, and never persist resolved ids as the source of truth.
