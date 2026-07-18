# Printavo Hub

Unified internal hub for Mint Printworks that consolidates 11 separate Printavo-connected apps into one platform (plus a future public Reorder Portal), built on a shared Printavo sync engine.

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
- `artifacts/api-server/src/lib/sync/` — sync engine (seed, incremental poll, detail backfill, payments, differ/hashing, upserts, scheduler, run state)
- `artifacts/api-server/src/routes/sync.ts` — sync status/poll/events API
- `artifacts/api-server/src/lib/reports/` + `src/routes/reports.ts` — Reports module (reads Postgres ONLY, never the Printavo API — module isolation)
- `packages/api-spec/` — OpenAPI source of truth; run codegen after route changes (reports endpoints not yet in spec — deferred to UI phase)

## Architecture decisions

- Printavo v2 has NO `updatedAfter` filter and no UPDATED_AT sort (verified via live schema introspection). Incremental sync therefore does a full re-crawl of invoices+quotes (VISUAL_ID desc, early-stop at a rolling 12-month createdAt cutoff) every 5 min and detects changes by content hash (~140 requests, ~2.3 min per poll — ~23% of the 10 req/5s account budget).
- All fetched nodes pass through timestamp normalization (every ISO8601 string → UTC) before hashing/storing, because Printavo renders the same instant in varying timezones between fetches.
- Watermarks are seed-completion markers / poll timestamps only, not incremental cursors.
- Known Phase-1 limitations (accepted): orders older than the 12-month window silently age out of syncing; Printavo-side deletions are not detected; early-stop assumes VISUAL_ID order correlates with createdAt.

## Product

- Phase 1 (done): Printavo sync engine — 12-month seed + 5-min incremental polling of quotes/invoices/customers/contacts/statuses into Postgres, with change-event capture (created/updated/status_change/converted).
- Phase 2 (backend done, awaiting Tyler validation + UI): order detail sync (line item groups/items/imprints), full payments history sync (cash-basis, 2017→today), and Reports API under `/api/reports/*` replicating the legacy Insights app formulas (see `.agents/memory/printavo-reporting-formulas.md`).
- Vendor Orders / Purchasing module (P1–P4 COMPLETE, July 2026): needs-ordering scan, vendor pricing (SanMar SOAP + S&S REST), PO builder w/ cart + warehouse auto-pick, PO Log w/ two-tier lock model, push-to-Printavo (line item updates + production file attach via throttled gateway), status rules engine (`/status-rules`, suggestions only — staff confirms each apply), electronic vendor submission (SanMar + S&S both live-verified end-to-end, kill-switch + PIN-gated, anti-double-order guards), and tracking dashboard (`/tracking`).
- Price Calculator (PC1–PC4 complete, July 2026): faithful Breezy Quote port — decoration matrices CRUD + CSV import, quote engine w/ vendor cost lookup, PNG export. Route `/price-calculator`.
- Print Queue module (PQ1–PQ3a complete, July 2026): status-filtered workorder printing, bulk status change + queue rules (kill-switch gated), auto-print workorder PDFs → PrintNode (`/auto-print`). Remaining: PQ3b — in-house packing slips / box labels rendered from local data.
- moMINTum task app (integrated July 2026): the standalone moMINTum app's frontend ported as artifact `artifacts/momintum` (served at `/momintum/`), backed by `/api/momintum/*` routes in the hub api-server that read/write the standalone app's LIVE production Postgres via `MOMINTUM_DATABASE_URL` (lazy proxy in `lib/momintum-db`). Both apps share the same data and stay in sync. HARD RULES: member identity resolves BY EMAIL ONLY (oldest row wins — email is not unique); `members.clerk_user_id` belongs to the standalone app's Clerk tenant and must NEVER be written from the hub; hub JIT-creates missing members with NULL clerk_user_id (under a pg advisory lock to prevent duplicates). Routes mount behind `requireStaff` and only when `MOMINTUM_DATABASE_URL` is set — the check runs at boot, so adding/removing that secret requires an api-server restart (acts as a kill switch). TickTick/Missive/onboarding/invite features intentionally NOT ported (they live in the standalone app). Known parity behavior kept as-is: `PATCH /members/:id` is not admin-gated (matches standalone), so any staff member can toggle moMINTum admin flags.
- Known partial data: orders 20104 and 20714 have >25 line-item groups (beyond single-order query caps) — their line items are stored incomplete by design; exclude from report spot checks.

## Roadmap ideas (Tyler, July 8 + 13, 2026)

- Complete Printavo backup of ALL data + scheduled resync (Backup module from the original consolidation list — full-fidelity archive beyond the 12-month sync window).
- Internal customer portal: quick-access page per customer — branding colors, popular styles, contacts, assignable customer type/category. Builds on the customer-enrichment layer: Hub-owned fields in a separate table keyed to the Printavo customer ID — never write into the synced mirror tables.
- Color catalog/database: also the source of the color-matching catalog for the Breezy tweak app (separate SaaS) — design it to be reusable/exportable (likely a key-authed API like catalog search).
- Centralized knowledge base: FAQ, SOPs, internal reference docs — structured for BOTH human use and AI/platform integrations to consume.
- External analytics hub (admin-only vs granted-access tiers required): Fireflies (meeting notes), JustCall (phone/auto-attendant/virtual CS), Google Analytics (web traffic/AdWords/SEO), Meta (ads & socials), RB2B (website visitor identification), EmailAnalytics (Google Workspace email stats), ActivTrak (computer/browser activity), Constant Contact (email campaigns), possibly more. Depends on staff auth with roles.
- Sales & front-end support tools: customizable proactive follow-up reminders for past customers, receivables tracking, custom notifications on customer activity (order value thresholds, customer type, new customer, …).
- Maintenance & sidework log with scheduled reminders — possibly tied into the task management app integration.
- Preset reports library in the Reports module — Tyler has a list to work through.
- (Also logged in session plan: outgoing activity log, task management app integration, Missive messaging portal, public Reorder Portal.)

## User preferences

- **Build one step at a time, testing as we go** (Tyler, July 8, 2026): start with the foundation and verify each phase works before moving to the next — no big-bang builds.
- **Module isolation is a hard requirement**: individual functional pieces (Reports, Ordering, Mint Bucks, Print Queue, Color Library, Breezy, Shipping, Backup, Portal) must be tunable/iterable independently without breaking the others.
- **Test order is #22251 ONLY** (Tyler, July 13, 2026): "TEST DO NOT ORDER" (printavoId 23448572). Do NOT test with order #19004 anymore — Printavo automations fired customer emails when its status changed. Any real-write testing uses #22251 exclusively; if a different order is ever needed, ask Tyler first. (#18371 was considered but is outside the sync window.)

## Gotchas

- Printavo rate limit is account-wide (10 req/5s) — shared with Tyler's other live apps until they're decommissioned; keep polling headroom.
- Never hash Printavo nodes without `normalizeTimestamps()` — timezone flapping creates thousands of spurious change events.
- Poll requests via curl time out client-side (~2.3 min run) but continue server-side; check `sync_runs` table instead.
- Scheduler ticks ~5 min after boot and every 5 min after; orphaned incremental runs are auto-failed at boot. Interrupted seed/detail-backfill/payments-seed runs are resumed at boot AND re-checked on every tick (self-healing if two interrupted runs collide at boot).
- Drizzle `sql` template expands a JS array into a tuple `($1,$2,…)` — for `= ANY(...)` you MUST wrap with `sql.param(arr)` or Postgres errors with "op ANY/ALL (array) requires array on right side".
- Printavo single-order detail query complexity cap is 25k — top-up limits are 20 groups / 40 items / 15 imprints per group (25/50/25 = 29,636, rejected).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
