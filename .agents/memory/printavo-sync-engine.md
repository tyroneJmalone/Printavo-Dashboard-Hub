---
name: Printavo sync engine design facts
description: Durable findings from reading the PrintavoBackup source repo and Printavo v2 API docs that constrain the Hub sync engine design
---

# Printavo sync engine — key facts

**Source repo:** `https://github.com/tyroneJmalone/PrintavoBackup.git` — WENT PRIVATE (clone auth-failed July 2026). Hub sync engine was rebuilt from these notes instead; if Tyler restores access it's only useful for cross-checking GraphQL field sets.

**Hub v1 note:** order-list GraphQL field sets in `lib/printavo/src/queries.ts` are best-guess pending the first live probe — if Printavo rejects a field, the GraphQL error names it; trim and retry.

## Official docs (provided by Tyler, July 8 2026)
- v2 GraphQL (the one to use — all 11 apps use it exclusively): https://www.printavo.com/docs/api/v2
- v1 REST (legacy Apiary docs — reference only, do not build on): https://printavo.docs.apiary.io/#

## API constraints (Printavo GraphQL v2)
- `updatedAfter` filter is supported ONLY on `invoices` and `quotes` queries. All other entities (customers, contacts, transactions, tasks…) must be fully re-fetched and filtered client-side by `timestamps.updatedAt`.
- Rate limit: 10 requests / 5 seconds. Max query depth 13, max complexity 25,000.
- No `UPDATED_AT` sort field — only VISUAL_ID, CUSTOMER_DUE_AT, CUSTOMER_NAME, OWNER, STATUS, TOTAL.
- `products()` requires a mandatory `query: String!` arg (pass "").
- `LineItemStatus` enum includes `need_ordering`; `PoGoodsStatus` includes `not_ordered`.

## Sync cost reality
- Invoice sync is two-phase: cheap ID list (with updatedAfter), then 2+ requests PER invoice (detail + lineItemGroups + mockup downloads).
- Full crawl of ~17k orders ≈ 35k+ requests ≈ 5+ hours at rate limit. Page-count math is wrong; per-invoice math is right.
- **Why:** this makes a limited initial seed (last 12 months) essential, with historical backfill as a throttled background job.

## What the backup queries already fetch vs. missing
- ALREADY fetched: `productStatus` on line items (powers Needs Ordering scan), `timestamps {createdAt updatedAt}`, fees, transactions (union of Payment/Refund/Void/Return/PaymentDispute), imprints + pricingMatrixColumn, mockups, workorderUrl, publicUrl.
- MISSING: `poLineItem → purchaseOrder → goodsStatus` traversal (needed by Vendor Submission module). Must be added; watch depth-13 limit.

## Proven patterns to port
- Watermarks: per-entity, DB-backed (`entity_watermarks` table), set to RUN-START time (not completion), never advanced on per-record errors. Closes race windows.
- Checkpoint/resume: `checkpoint.json` per run dir; stale "running" runs resume at entity granularity.
- Rate limiter: sliding-window client-side + exponential backoff on 429.
- Auth: headers `email` + `token` on POST to `https://www.printavo.com/api/v2`.
- Backup app stores Printavo creds in DB (`backup_config` table), not env vars — same as Vendor Submission app.

## Hub plan implication
Backup repo provides ~80% of Stage 1: reuse client/queries/watermark/checkpoint logic; replace JSON-file storage with normalized Postgres tables; add goodsStatus traversal; add seed mode (12-month cutoff by createdAt, paginate VISUAL_ID desc with early stop).
