---
name: Printavo productStatus changes are invisible to updatedAt-based sync
description: Line-item productStatus edits never bump the order's updatedAt — hash/watermark change detection misses them; the Hub runs a slim per-poll sweep to compensate
---

# Rule
Changing a line item's `productStatus` in Printavo (e.g. flagging "Need Ordering") does NOT bump the parent order's `updatedAt` or any list-level field. Any sync design that detects changes via order updatedAt / list-hash diffing will silently miss these edits.

**Why:** Verified live July 2026 — order flagged need_ordering in Printavo still reported its old updatedAt; the Hub's queue stayed stale until the once-daily full detail re-crawl (up to 24h lag), which broke the "flag → Sync now → build PO" workflow.

**How to apply:** The incremental poll runs a slim product-status sweep (invoices only, VISUAL_ID desc, line item id+productStatus, legacy PO Builder complexity limits 25×5×8 — do not raise) and diffs against pv_line_items, refreshing details of disagreeing orders. Scheduler polls sweep ~250 newest invoices; manual "Sync now" sweeps ~1250 (legacy full depth). Known blind spots (deliberate): quotes are not swept, and items beyond the 5-group/8-item nesting caps are invisible to the sweep — both covered within 24h by the daily detail recrawl. If a "flagged but not appearing" report ever involves a quote or a huge order, that is why. Suspect the same updatedAt blindness for OTHER child-only edits (imprints, size edits?) — the daily recrawl is the only guaranteed catch-all.
