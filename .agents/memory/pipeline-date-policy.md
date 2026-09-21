---
name: Pipeline explicit date filter precedence
description: Explicit date ranges replace the implicit Won/Done age window.
---

An explicit Pipeline date bound replaces the usual Won/Done creation-age cutoff; it must not silently intersect with that cutoff.

**Why:** A user selecting an older production or invoice date range expects matching orders, even if they were created outside the default recent-sales window. Keeping both restrictions silently hides legitimate results.

**How to apply:** Preserve the recent-sales default when no date bounds are selected. With explicit dates, make the override visible and keep saved-view restoration consistent with this rule.