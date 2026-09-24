---
name: Purchasing warehouse proximity
description: NH-relative warehouse priority and limits of regional location estimates.
---

For purchasing, prefer full stock coverage and consolidation first, then proximity to New Hampshire before stock depth. Preserve explicit warehouse overrides.

**Why:** The user requested NH proximity in addition to the existing split-shipment reduction policy, then supplied a delivery ZIP to refine the original state-level approximation. Geographic proximity is not a promised shipping cost or delivery time.

**How to apply:** Use the configured destination rather than reverting to the original state-level reference. Some S&S abbreviations identify regions rather than exact facilities. Keep that uncertainty visible in names; a destination ZIP alone still does not establish carrier transit times.