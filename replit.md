# Printavo Hub

Unified internal hub for Mint Print Works that consolidates 11 separate Printavo-connected apps into one platform (plus a future public Reorder Portal), built on a shared Printavo sync engine.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/printavo/` — standalone Printavo GraphQL v2 client (throttle 620ms, 429 retry, typed queries)
- `packages/db/` — Drizzle schema: `pv_*` mirror tables, `sync_runs`, `sync_checkpoints`, `entity_watermarks`, `change_events`
- `artifacts/api-server/src/lib/sync/` — sync engine (seed, incremental poll, differ/hashing, upserts, scheduler, run state)
- `artifacts/api-server/src/routes/sync.ts` — sync status/poll/events API
- `packages/api-spec/` — OpenAPI source of truth; run codegen after route changes

## Architecture decisions

- Printavo v2 has NO `updatedAfter` filter and no UPDATED_AT sort (verified via live schema introspection). Incremental sync therefore does a full re-crawl of invoices+quotes (VISUAL_ID desc, early-stop at a rolling 12-month createdAt cutoff) every 5 min and detects changes by content hash (~140 requests, ~2.3 min per poll — ~23% of the 10 req/5s account budget).
- All fetched nodes pass through timestamp normalization (every ISO8601 string → UTC) before hashing/storing, because Printavo renders the same instant in varying timezones between fetches.
- Watermarks are seed-completion markers / poll timestamps only, not incremental cursors.
- Known Phase-1 limitations (accepted): orders older than the 12-month window silently age out of syncing; Printavo-side deletions are not detected; early-stop assumes VISUAL_ID order correlates with createdAt.

## Product

- Phase 1 (current): Printavo sync engine — 12-month seed + 5-min incremental polling of quotes/invoices/customers/contacts/statuses into Postgres, with change-event capture (created/updated/status_change/converted).

## Roadmap ideas (Tyler, July 8, 2026)

- Customer enrichment layer on top of synced `pv_customers`: Hub-owned fields such as logo colors, top purchased styles, and a customer category tag ("contractor", "sports", …). Keep in a separate Hub table keyed to the Printavo customer ID — never write into the synced mirror tables.
- Color database built here will also be the source of the color-matching catalog for the Breezy tweak app (separate SaaS) — design it to be reusable/exportable.

## User preferences

- **Build one step at a time, testing as we go** (Tyler, July 8, 2026): start with the foundation and verify each phase works before moving to the next — no big-bang builds.
- **Module isolation is a hard requirement**: individual functional pieces (Reports, Ordering, Mint Bucks, Print Queue, Color Library, Breezy, Shipping, Backup, Portal) must be tunable/iterable independently without breaking the others.

## Gotchas

- Printavo rate limit is account-wide (10 req/5s) — shared with Tyler's other live apps until they're decommissioned; keep polling headroom.
- Never hash Printavo nodes without `normalizeTimestamps()` — timezone flapping creates thousands of spurious change events.
- Poll requests via curl time out client-side (~2.3 min run) but continue server-side; check `sync_runs` table instead.
- Scheduler ticks ~5 min after boot and every 5 min after; orphaned incremental runs are auto-failed at boot.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
