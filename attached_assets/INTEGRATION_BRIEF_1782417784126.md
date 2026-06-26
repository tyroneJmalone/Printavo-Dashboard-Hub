# Printavo Reporting Dashboard — Architecture & Integration Brief

> Context document for planning the consolidation of 4 Printavo-connected apps
> into one dashboard. All 4 apps will be tied into the **same Printavo account**.

## 1. What it is
A reporting/analytics dashboard for a custom screen-printing & embroidery business. It pulls order/payment data from Printavo, caches it server-side, and presents filtering, breakdowns, KPI cards, CSV export, an "Ask AI" natural-language query feature, and scheduled email reports.

## 2. Tech stack
- **Frontend:** React + TypeScript + Vite, Tailwind + shadcn/ui, `wouter` (routing), `@tanstack/react-query` (data), `recharts` (charts).
- **Backend:** Express.js (TypeScript, run via `tsx` in dev, bundled to `dist/index.cjs` for prod). Acts as a caching proxy in front of Printavo.
- **DB:** Replit-provisioned PostgreSQL via `drizzle-orm` + `pg` (`DATABASE_URL`).
- **Single port:** Express + Vite both serve on **port 5000** (→ external 80). `npm run dev` runs everything.
- **AI:** OpenAI via Replit AI Integrations (gpt-5.1).
- **Email:** `nodemailer` over SMTP.

## 3. Printavo API integration (the core — read this twice)
Printavo exposes **two APIs, both used here with the same credentials** (`PRINTAVO_EMAIL` + `PRINTAVO_API_TOKEN`):

- **REST API v1** (`https://www.printavo.com/api/v1/`) — auth via `email` + `token` query params. Source of orders, statuses, categories, payments. Paginated.
- **GraphQL API v2** (`https://www.printavo.com/api/v2`) — auth via `email` + `token` **headers**. Used only for *enrichment*: tags + pricing-matrix data that v1 doesn't expose.

**Rate limit (CRITICAL for combining apps): ~10 requests / 5 seconds, shared across BOTH v1 and v2, per Printavo account.** The app respects this with a **550 ms delay between every page** and exponential-backoff retry (1s→10s) on 5xx/timeouts.

**Pagination quirks:**
- v1 `/orders` is sorted by `visual_id` (creation order) **descending — NOT by `updated_at`.** This is the single most important data-freshness gotcha (see §7).
- v1 orders: ~17k records, fetched at 100/page up to maxPages=200.
- v1 payments: fetched at high page count (maxPages=150), ~12k records.
- v2 GraphQL: 25/page up to maxPages=800, sorted `VISUAL_ID` descending to align with the v1 cache. Enrichment merges into orders **by `visual_id`** (string key).

## 4. Data flow & caching
```
boot → load disk cache (.cache/*.json) → serve dashboard instantly
     → background full v1 crawl from Printavo → update cache → save to disk
     → background v2 GraphQL enrichment crawl → merge tags/pricing → save to disk + Postgres
```
- **Orders cached in-memory** with a 5-min TTL; all filtering/sorting/pagination happens **server-side on the cached set** (the frontend never hits Printavo directly).
- **Two refresh modes:**
  - *Incremental* (TTL auto-refresh): fetches only newly-created orders and merges. **Limitation:** because v1 is sorted by creation, incremental only catches *brand-new* orders — it **silently misses status/date edits to older orders.**
  - *Forced/full* (Refresh button + scheduled): complete re-fetch of all orders + full v2 enrichment recrawl. This is the only reliable way to capture edits to existing orders.
- **v2 enrichment crawl is slow** (multi-minute; worst case ~30 min for the full two-pass crawl). This is why enrichment is persisted to Postgres (see §5) — so pricing-matrix data survives a redeploy instead of going blank during warmup.

## 5. Persistence model (what lives where)
| Data | Where | Why |
|---|---|---|
| Orders (~50–150 MB) | in-memory + `.cache/orders.json` | too big/churny for DB; regenerable |
| Payments | in-memory + `.cache/payments.json` | regenerable |
| v2 enrichment (tags/pricing) | in-memory + `.cache/enrichment.json` + **Postgres `enrichment_cache` (JSONB)** | crawl is slow; must survive redeploy |
| Scheduled email reports | **Postgres `report_schedules` (JSONB)** | user config; must survive redeploy |

- **`.cache/` is ephemeral — wiped on every republish.** Anything a user creates must go in Postgres, never disk.
- **Partial-crawl guard:** never overwrite a good enrichment snapshot with a materially smaller one (<90% of last saved count) — the GraphQL crawl can return partial data without throwing.
- Two Postgres tables only: `report_schedules` and `enrichment_cache`.

## 6. Scheduled jobs (two separate in-process timers)
1. **Data refresh** (`startPeriodicRefresh` in `routes.ts`): forces a full orders + enrichment + payments refresh at **12:00 AM and 12:00 PM America/New_York**.
2. **Report scheduler** (`scheduler.ts`): sends scheduled email reports (daily/weekly/monthly). Timing is pinned to America/New_York, with **missed-window catch-up** (a missed send still goes out later within its period, deduped so it never double-sends) and a `created_at` baseline so newly-tracked schedules don't blast a catch-up email on first deploy.

Both rely on the always-on process — **they require Reserved VM, not autoscale.**

## 7. Deployment model & gotchas
- **Must deploy as Reserved VM** (`deploymentTarget = "vm"`). The background crawler, in-process cron, and large warm caches all break on autoscale (instances recycle, wipe `.cache`, kill the crawl, miss/duplicate scheduled sends).
- **Dev and prod are SEPARATE Postgres databases.** During Publish, do **not** choose "overwrite production data with development data" — it will wipe prod's real scheduled reports. Keep prod data.
- Accepted tradeoff: each redeploy starts with empty `.cache`, so there's a warmup window (pricing-matrix data is hydrated quickly from the Postgres `enrichment_cache`, orders re-crawl in a few minutes).

## 8. Printavo data-model gotchas (hard-won — these will bite a new agent)
- **Line-item revenue:** v1 line items have **no `total`/`price`**. Revenue = `unit_cost × total_quantities`. Despite the name, **`unit_cost` is the per-unit *selling price*, not cost** (verified: sums match `order_total` within ~1%). v2 equivalent: `LineItem.price × LineItem.items`.
- **Category is line-item-level, not order-level.** There is no `order.category` (always undefined). Derive decoration type from `order.lineitems[].category`; an order can span multiple categories.
- **`lineitems_attributes` → normalized to `lineitems`; `order_total` → `total`** in normalization.
- **Imprints metric:** Σ over line-item groups of (group quantity × number of imprint locations on that group). E.g. a 100-qty group with 2 print locations = 200 imprints. Requires v2 enrichment data.
- **Pricing-matrix path in v2:** `Invoice → lineItemGroups → imprints → pricingMatrixColumn → matrix.name`. Tags are a `[String!]!` on Invoice/Quote (union type → inline fragments required). Sort uses `sortDescending: Boolean`, not `sortDirection`.

## 9. API surface (all under `/api`)
`orders`, `orders/:id`, `payments`, `payments/stats`, `statuses`, `categories`, `account`, `filter-options`, `status-breakdown`, `style-number-breakdown`, `brand-breakdown`, `color-breakdown`, `pricing-matrix-breakdown`, `order-quantity-breakdown`, `imprints-by-tier`, `ask-ai` (POST, SSE stream), `smtp-status`, and full scheduled-reports CRUD (`GET/POST /schedules`, `PUT/DELETE /schedules/:id`, `POST /schedules/:id/test`). Multi-select filter values are `||`-delimited in query params.

## 10. Environment / secrets required
`PRINTAVO_EMAIL`, `PRINTAVO_API_TOKEN`, `DATABASE_URL`, `SESSION_SECRET`, SMTP set (`SMTP_HOST/PORT/USER/PASS/FROM`), and AI Integrations (`AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, auto-injected).

## 11. File map
- `server/printavo.ts` — Printavo v1 REST + v2 GraphQL client (retry/backoff, pagination, enrichment crawl).
- `server/routes.ts` — all API routes, filtering/sorting/caching, enrichment pipeline, periodic refresh.
- `server/scheduler.ts` — report scheduler (ET timing, catch-up), preset date-range resolution, email HTML.
- `server/db.ts` / `server/storage.ts` — Postgres pool + storage interface.
- `shared/schema.ts` — Drizzle tables + Zod schemas + shared types.
- `client/src/pages/dashboard.tsx` + `client/src/components/*` — UI (filter panel, breakdowns, stats cards, ask-ai, scheduled-reports, orders table).

---

## 12. Recommended merge architecture (same Printavo account)
Because all four apps point at the **same Printavo account**, the dominant constraint is the **shared rate limit (10 req / 5 sec across v1 + v2)**. Four apps each running their own crawler will throttle each other into backoff and failures. The merge must therefore collapse the data layer into one shared pipeline, with the four apps' unique features becoming views on top of it.

### Core principle: one data layer, many views
```
                ┌─────────────────────────────────────────────┐
                │   Shared Printavo data layer (single owner)  │
                │  • one rate-limited fetch queue (550ms/page) │
                │  • one orders cache (memory + disk)          │
                │  • one v2 enrichment crawl (→ Postgres)      │
                │  • one scheduler/refresh timer               │
                └───────────────┬─────────────────────────────┘
                                │ (server-side reads, no extra Printavo calls)
        ┌───────────────┬───────┴───────┬────────────────┐
     App A view     App B view      App C view       App D view
   (endpoints +    (endpoints +    (endpoints +     (endpoints +
    UI tabs)        UI tabs)        UI tabs)         UI tabs)
```

### Concrete steps for the integrating agent
1. **Adopt one canonical fetch + cache layer.** This app's `server/printavo.ts` + caching model (memory + disk + Postgres enrichment) is a solid base. Every Printavo call from all four apps must go through this single rate-limited path — never let any merged app call Printavo directly.
2. **Run the data crawls exactly once, shared.** One full v1 orders crawl and one v2 enrichment crawl feed all four feature sets. Do not 4× the GraphQL load; the enrichment crawl alone can take up to ~30 min.
3. **Consolidate to a single scheduler.** If any of the other apps has its own in-process cron/refresh, merge them into one timer (this app already has data-refresh + report-scheduler timers). Multiple schedulers → duplicate refreshes and duplicate/missed emails. Keep all timing in one timezone (this app uses America/New_York).
4. **Turn each app's unique logic into endpoints/views over the shared cache.** Map each app's distinctive reports/screens onto new `/api/*` routes that read the shared in-memory dataset and into UI tabs/pages (use `wouter` routing + a sidebar). No app should own its own copy of the orders.
5. **Reconcile the data-model definitions across all four apps (see §8).** If any app computes revenue, category, or imprints differently, the merged dashboard will show contradictory numbers. Pick one canonical definition for each metric and apply it everywhere.
6. **Carry over the persistence rules:** user config in Postgres (per-row CRUD, let read failures throw), regenerable data on disk, never overwrite prod data on publish, guard against partial-crawl overwrites.
7. **Deploy as one Reserved VM.** The combined app keeps the background crawler + in-process cron + warm caches, so autoscale is still off the table.

### Things to confirm before building
- **Credentials:** one shared `PRINTAVO_EMAIL` / `PRINTAVO_API_TOKEN` pair for the whole app (single account → single credential set).
- **Feature overlap:** identify where the four apps already duplicate each other (e.g. order tables, status breakdowns) and pick one implementation rather than carrying four.
- **Cache size:** orders cache is already ~50–150 MB in memory; consolidating four feature sets onto one shared cache is *more* memory-efficient than four copies, but size the Reserved VM accordingly.
