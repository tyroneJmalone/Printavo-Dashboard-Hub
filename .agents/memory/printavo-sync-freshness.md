---
name: Printavo sync freshness model
description: What the incremental poll covers per-tick vs once-daily, and the force-write rule for sweep-triggered refreshes.
---

# Printavo sync freshness model

- Printavo API quirks that shape everything: no UPDATED_AT sort (VISUAL_ID desc is the recency proxy), and line-item productStatus edits do NOT bump the order's updatedAt (verified live July 2026). The product-status sweep exists because of the second quirk.
- Poll order: sweep + mismatch refreshes run FIRST (vendor-queue freshness lands ~50s into a manual sync), then list crawls with early-stop (floor pages + K consecutive all-unchanged pages), then remaining hash-changed detail refreshes.
- All once-daily heavy work (full list crawl, full detail re-crawl, reference, payments full) is gated on trigger === "scheduler". Manual "Sync Now" must NEVER pay a daily cost — the full detail re-crawl alone is ~16 min.
- Freshness guarantee to communicate: recent-order changes land within one 5-min scheduled tick (~30s runs); edits to orders deep in history (beyond early-stop floors) can be up to ~24h stale until the nightly full crawls.

**Force-write rule:** when an independent diff (the sweep) has PROVEN DB != API for an order, the detail refresh must bypass the detailContentHash short-circuit (`force: true`). Otherwise a drifted DB row whose stored hash still matches the API gets re-flagged and skipped every poll forever — permanent stale data plus a wasted request per poll.

**Why:** hash short-circuits assume the DB rows are consistent with the stored hash; any external evidence of drift invalidates that assumption.

**How to apply:** any future "detect drift → repair" path must not trust content-hash equality as proof of freshness; either force the write or delete the stored hash.

Debugging tip: real run durations/breakdowns live in `sync_runs` (columns: run_type, status, started_at, finished_at, stats jsonb — stats.trigger, per-list pages/earlyStopped, productStatusSweep, details).
