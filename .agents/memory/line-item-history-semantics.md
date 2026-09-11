---
name: Line-item history semantics
description: Baseline, completeness, and attribution boundaries for observed Printavo line-item changes.
---
Line-item history starts from a complete baseline, not reconstructed historical edits. Keep incomplete observations out of comparisons and show their limitation explicitly.

**Why:** Polling observes net changes, not Printavo audit events; a truncated response can otherwise fabricate removals. Overlapping backfills and refreshes can also arrive out of order.

**How to apply:** Preserve per-order serialized comparisons and stale-fetch rejection when changing sync. Never describe invoice ownership as the identity of the person who edited a line. First observations establish baselines without emitting additions.