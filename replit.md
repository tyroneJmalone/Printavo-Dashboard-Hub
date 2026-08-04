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
- moMINTum task app (integrated July 2026): the standalone moMINTum app's frontend ported as artifact `artifacts/momintum` (served at `/momintum/`), backed by `/api/momintum/*` routes in the hub api-server that read/write the standalone app's LIVE production Postgres via `MOMINTUM_DATABASE_URL` (lazy proxy in `lib/momintum-db`). Both apps share the same data and stay in sync. HARD RULES: member identity resolves BY EMAIL ONLY (oldest row wins — email is not unique); `members.clerk_user_id` belongs to the standalone app's Clerk tenant and must NEVER be written from the hub; hub JIT-creates missing members with NULL clerk_user_id (under a pg advisory lock to prevent duplicates). Routes mount behind `requireStaff` and only when `MOMINTUM_DATABASE_URL` is set — the check runs at boot, so adding/removing that secret requires an api-server restart (acts as a kill switch). HUB-OWNED TABLES IN THE LIVE moMINTum DB: `list_groups` + `list_group_memberships` (added 2026-07-19, additive-only; membership kept in a separate table so the standalone app's drizzle tooling never sees unknown columns on `lists`; the standalone app must never drop these tables). The hub's List DTO exposes `groupId` by joining the membership table. TickTick/Missive/onboarding/invite features intentionally NOT ported (they live in the standalone app). Known parity behavior kept as-is: `PATCH /members/:id` is not admin-gated (matches standalone), so any staff member can toggle moMINTum admin flags.
- Mint Bucks store-credit module (integrated July 2026): the standalone Mint Bucks app ported into the hub with full feature parity — pages under `/mintbucks/*` in the hub frontend (Dashboard, Customers, Credits, Issue/Detail, Redemptions, Rewards, Reports, Certificate History, Check Credit, Settings), backed by `/api/mintbucks/*` routes (mounted behind `requireStaff`, only when `MINTBUCKS_DATABASE_URL` is set — boot-time check, acts as kill switch) reading/writing the standalone app's LIVE production Postgres via lazy proxy in `lib/mintbucks-db`. HARD RULES: Printavo credentials come from hub env (`PRINTAVO_API_TOKEN`/`PRINTAVO_API_EMAIL`) — the settings-table keys `printavo_api_key`/`printavo_email`/`printavo_shop_url` are write-blocked from the hub; QR/certificate/email links require `MINTBUCKS_APP_URL` (endpoints return 503 if unset — never fall back to the dev domain); outbound email redirects to tyler@mintprintworks.com with `[TEST→orig]` subject unless `MINTBUCKS_EMAIL_MODE=live`; the reward/order poller stays DORMANT unless `MINTBUCKS_POLLER_ENABLED=true` (phased ownership — the standalone app keeps polling until Tyler flips it; flip = set secret + restart api-server, and turn OFF the standalone poller first to avoid double-issuance). Reward issuance is idempotent via `(rule_id, printavo_invoice_id)` claim + advisory lock; order emails claim via `notification_log` ON CONFLICT. NEVER run drizzle push against the Mint Bucks DB. Money values are strings (numeric columns). HANDOFF CAVEATS: (1) manual hub polls/scans in email-test mode still consume the shared one-shot ledgers (`notification_log`, `reward_awards`) — the redirected [TEST→…] email counts as "sent", so the standalone app will never send the real customer email for that order/award; avoid manual poll triggers on live data until email mode is live or ownership has flipped. (2) `printavo_enabled`/`rewards_enabled` live in the shared settings table — toggling automation in the hub also starts/stops the STANDALONE app's poller. (3) Printavo credential fields on MB Settings are read-only in the hub UI (write-blocked server-side); only automation toggle + polling interval are saveable.
- Printavo ⇄ moMINTum task sync (PT1–PT5, July 2026): `/api/printavo-tasks/*` (admin-gated; mounted only when both `MOMINTUM_DATABASE_URL` and Printavo creds are set). Imports Printavo tasks as moMINTum "twins" (routing: matched assignee → private, order-tied unassigned → shared Production, else shared General), two-way completion (boolean 3-way reconcile vs link baseline), vanished-task probes (complete/soft-delete twins), send-to-Printavo, and FE safeguard confirmations for actions on Printavo-linked tasks. Link table `printavo_task_links` lives in the HUB DB. Interval poller (5 min) is DORMANT unless `PRINTAVO_TASK_SYNC_ENABLED=true`. HARD RULE: that flag may be true in AT MOST ONE environment at a time (dev OR deployment, NEVER both) — each environment has its own hub DB/link table but both write twins into the SAME live moMINTum DB, so two enabled environments would each import every Printavo task and create duplicate twins. Flip = set secret in the chosen env + restart its api-server; verify the other env's flag is unset first. Manual `POST /api/printavo-tasks/sync-now` works regardless of the flag (still one-cycle-at-a-time guarded).
- Ask AI insights (AI1, July 2026): `/ask` page — natural-language questions over the local Printavo mirror via guarded LLM→SQL (`/api/insights/*`). Guard stack: SELECT-only validator + NOLOGIN `insights_ro` role (SELECT on 18 whitelisted tables only, re-granted each boot — staff list/presets/print-queue tables invisible) + READ ONLY txn + 5s timeout + 500-row cap. Saved presets re-run stored SQL deterministically (no AI). Whole ask flow budgeted at 40s (Replit proxy kills ~48s held requests). PROVIDER: Replit-managed OpenAI proxy for now; PLANNED SWAP to Tyler's own OpenAI developer key = env-var change only (`AI_INTEGRATIONS_OPENAI_BASE_URL`/`AI_INTEGRATIONS_OPENAI_API_KEY` → api.openai.com + his key), no code changes. DEPLOY NOTE: `insights_presets` table + `insights_ro` role/grants are needed in prod — role/grants auto-apply at boot; table ships with the next schema push.
- Chipply web-stores module (CH1, July 2026): `/chipply` — import Chipply "Web Store Closed" emails via smart-paste (parser tolerant, ALL fields editable in a mandatory review step — parser was built from ONE sample email), stores land in hub-DB `chipply_stores`. Links to Printavo $0 merch invoices are DERIVED LIVE from the nickname prefix convention `"<eventId> <Store Name> <METHOD>:"` (eventId = 5–7 digits) — NO link table, deliberately, so renamed/added invoices link themselves. HARD RULE: Chipply dollars (total/fundraising) live ONLY in `chipply_stores` and must NEVER be summed into Printavo revenue reports (the linked invoices are $0 shells). "Detected in Printavo" tab lists all nickname-prefix groups (~295) not yet imported, with import-prefill. DEPLOY NOTE: `chipply_stores` DDL ships with next schema push. CH2 (Tyler-confirmed, after his CH1 test): customer-profile Chipply section + Chipply reporting in Analyze/Insights/Reports (kept separate from Printavo revenue), plus CSV export imports and customer reassignment UI on the detail page. Method abbreviations in nicknames = decoration methods: EMB=Embroidery, SP=Screen Printing, DTF=Heat Applied Graphics.

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
- Stock availability checker (Tyler, Aug 4, 2026): salesperson types a style number, picks a color, app returns stock by warehouse across vendors (SanMar + S&S); plus a one-click stock check on a specific Printavo invoice's line items. High feasibility — reuses the existing vendor pricing/inventory clients and warehouse auto-pick logic from the PO builder, and the synced line-item mirror. Natural tie-in with the universal vendor product search / catalog-search API idea.

## User preferences

- **Build one step at a time, testing as we go** (Tyler, July 8, 2026): start with the foundation and verify each phase works before moving to the next — no big-bang builds.
- **Module isolation is a hard requirement**: individual functional pieces (Reports, Ordering, Mint Bucks, Print Queue, Color Library, Breezy, Shipping, Backup, Portal) must be tunable/iterable independently without breaking the others.
- **Test order is #22251 ONLY** (Tyler, July 13, 2026): "TEST DO NOT ORDER" (printavoId 23448572). Do NOT test with order #19004 anymore — Printavo automations fired customer emails when its status changed. Any real-write testing uses #22251 exclusively; if a different order is ever needed, ask Tyler first. (#18371 was considered but is outside the sync window.)
- **Automatic insights log** (Tyler, July 21–22, 2026): maintain `docs/insights-log.md` — a curated, dated, plain-language log of substantive explanations, insights, and decisions from chat. Append automatically whenever such an explanation is given (no need to be asked); Tyler can also say "log that" to capture something explicitly. **Also log every feasibility/possibility question Tyler asks** ("could we do X?", "is Y possible?") together with the answer and the reasoning behind it — even when the answer is no or the idea is deferred. Keep entries readable for a non-technical reader; newest first within each month.
- **Standalone-app handoff docs** (Tyler, July 19, 2026): whenever a hub change affects the shared moMINTum (or Mint Bucks) experience — new tables, new features, changed behavior visible to users of the standalone app — write a handoff document in `handoffs/` with exactly what the standalone app's agent needs to implement to keep both apps looking and working the same, and present it to Tyler. Include: what already exists in the shared DB (never re-create), schema details, UI/behavior to replicate, and hard warnings (don't drop hub-owned tables, don't add columns to shared tables).

## Gotchas

- Printavo rate limit is account-wide (10 req/5s) — shared with Tyler's other live apps until they're decommissioned; keep polling headroom.
- Never hash Printavo nodes without `normalizeTimestamps()` — timezone flapping creates thousands of spurious change events.
- Poll requests via curl time out client-side (~2.3 min run) but continue server-side; check `sync_runs` table instead.
- Scheduler ticks ~5 min after boot and every 5 min after; orphaned incremental runs are auto-failed at boot. Interrupted seed/detail-backfill/payments-seed runs are resumed at boot AND re-checked on every tick (self-healing if two interrupted runs collide at boot).
- Drizzle `sql` template expands a JS array into a tuple `($1,$2,…)` — for `= ANY(...)` you MUST wrap with `sql.param(arr)` or Postgres errors with "op ANY/ALL (array) requires array on right side".
- Printavo single-order detail query complexity cap is 25k — top-up limits are 20 groups / 40 items / 15 imprints per group (25/50/25 = 29,636, rejected).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
