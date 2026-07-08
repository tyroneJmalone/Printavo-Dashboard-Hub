---
name: Printavo detail truncation
description: Complexity caps and truncation-detection quirks when fetching full order detail (line item groups/items/imprints) from Printavo v2
---

# Printavo detail truncation

**Facts (verified July 2026, Mint Print Works account):**
- Single-order detail query complexity cap is 25,000. Limits 25 groups / 50 items / 25 imprints score 29,636 (rejected); the working top-up limits are **20 groups / 40 items per group / 15 imprints per group**.
- `pageInfo.hasNextPage` IS reliable at an exact page boundary: an order with exactly 20 groups returned `hasNextPage: false` at `first: 20/25` — no spurious true at the cap.
- The backfill `truncated` counter over-counts: it increments every time a still-truncated order is *seen*, and resume/checkpoint overlap re-visits orders (run reported 23; only 3 orders were actually at-cap in the DB, of which only 2 were genuinely incomplete when probed live).

**Why:** Diagnosing "how many orders have incomplete line items" from run counters alone is misleading; the DB at-cap heuristic (groups ≥ 20, items/group ≥ 40, imprints/group ≥ 15) + a live `order(id:)` probe with a higher `first:` gives the true answer.

**How to apply:** When auditing detail completeness, query the DB for at-cap orders, then probe those few orders live. Orders 20104 and 20714 have >25 groups and are stored partial by design (also noted in replit.md).
