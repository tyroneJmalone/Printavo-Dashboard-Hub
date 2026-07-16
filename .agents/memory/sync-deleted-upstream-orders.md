---
name: Deleted-upstream orders never backfill
description: Why some pv_orders rows permanently lack newly-added query fields; how new-field backfill actually works
---

# Deleted-upstream orders never backfill

Rule: rows in pv_orders whose orders were deleted/merged in Printavo are never returned by list crawls again, so they keep their last-synced `data` blob forever. Any newly added query field will be permanently absent on those rows.

**Why:** Observed 2026-07-16 after adding shippingAddress to the order query: full-depth list crawl (forced by clearing the `list_daily` watermark) saw exactly 3,406 orders while pv_orders held 3,476; the 70 missing rows had `synced_at` untouched and were old completed orders/quotes — deleted upstream. There is no delete-detection in the sync engine.

**How to apply:**
- Adding fields to the order GraphQL query self-backfills automatically: every fetched node's content hash changes, so the normal 5-min poll never early-stops and re-writes everything reachable — no manual crawl needed. Expect one long (~10 min) poll and change_events "updated" noise.
- If a poll doing this de-facto full crawl is interrupted (e.g. api-server restart), the next polls early-stop again; force completion by deleting the `list_daily` row in entity_watermarks (next SCHEDULED poll then does the full-depth crawl — manual "Sync now" never does).
- When a row "mysteriously" lacks a field every other row has, check whether Printavo still returns that order before suspecting the sync engine.
- Serving code must always handle absent new fields gracefully (e.g. "No shipping address on file" fallback) because deleted-upstream rows will never have them.
