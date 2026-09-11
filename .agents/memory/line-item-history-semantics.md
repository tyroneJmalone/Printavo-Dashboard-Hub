---
name: Line-item history semantics
description: Baseline, completeness, and attribution boundaries for observed Printavo line-item changes.
---
Line-item history starts from a complete baseline, not reconstructed historical edits. Keep incomplete observations out of comparisons and show their limitation explicitly.

**Why:** Polling observes net changes, not Printavo audit events; a truncated response can otherwise fabricate removals. Overlapping backfills and refreshes can also arrive out of order.

**How to apply:** Preserve per-order serialized comparisons and stale-fetch rejection when changing sync. Never describe invoice ownership as the identity of the person who edited a line. First observations establish baselines without emitting additions.

Owner activity reports intentionally attribute changes to the current owner, not the owner at event time. Counts represent recorded changes, not editing sessions or effort.

**Why:** The user wants visibility into activity on assigned quotes/invoices, but upstream editor attribution is unavailable and multiple field events may come from a single edit.

**How to apply:** Keep that distinction visible in reporting and summaries; do not present event counts as employee productivity scores.