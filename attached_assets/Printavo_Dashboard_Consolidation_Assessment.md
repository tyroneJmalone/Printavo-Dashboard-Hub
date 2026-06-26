# Printavo Dashboard Consolidation Assessment
**Prepared:** June 26, 2026
**Scope:** Consolidating ten Replit apps into one unified system ("Printavo Hub")

---

## Executive Summary

You currently operate **ten separate Replit applications**, most of which connect to the same Printavo account (`tyler@mintprintworks.com`). Several run their own Printavo data fetcher, their own background scheduler, and their own database. This causes **active reliability problems today** (the apps interfere with each other through a shared API rate limit) and creates real friction for your team (multiple logins, multiple tabs, no shared context, duplicated vendor integrations).

The ten apps fall into natural workflow groups:

| Group | Apps |
|---|---|
| **Analyze** | Reporting/Analytics, Ask AI (a feature of Reporting) |
| **Sales (customer-facing)** | Reorder Portal — *the only public app* |
| **Purchasing** | PO Builder (find & create POs), Vendor Order Submission (submit to SanMar/S&S + track) |
| **Production** | Workorder Manager (paperwork printing + auto-print), Color Reference DB (Pantone→thread/ink matching) |
| **Quoting** | Breezy Quote (decoration price calculator) |
| **Shipping** | Shipping Rate Estimator (USPS/UPS rates), PDF Sorter (slip + label matching) |
| **Data** | Printavo Backup (full account archive) |

**Recommendation: Consolidate into one system — but as two surfaces, not one app.** Nine of the ten are internal staff tools and fold cleanly into one dashboard. The tenth — the **Reorder Portal — is customer-facing**, so it must stay a separate *public* surface with its own access boundary. The right architecture is **one shared backend + data layer powering two front-ends**: the internal "Printavo Hub" dashboard for staff, and the public reorder portal for customers. The technical foundations are otherwise highly compatible (nearly all share React + Vite + Tailwind + shadcn/ui, Express + TypeScript, PostgreSQL + Drizzle), three apps already integrate with the same two vendors (SanMar + S&S), and consolidation solves real problems beyond UX — chiefly the rate-limit collisions caused by **two** independent full-account crawlers (Reporting and Backup) plus several smaller scanners all hitting one account.

---

## The Ten Apps

### 1. Reporting App (mintavoreports.replit.app)
Analytics and reporting dashboard for order data.

- Fetches and caches all Printavo orders (~17,000 records); KPI cards, rich filtering, breakdowns, payments, CSV export
- "Ask AI" — natural language queries against order data (GPT); scheduled email reports (daily/weekly/monthly)
- **Printavo:** all orders via REST v1; enrichment (tags, pricing matrix) via GraphQL v2 (slow crawl, up to 30 min); payments via REST v1
- **Background jobs:** full refresh at 12am/12pm ET; email scheduler · **DB tables:** `report_schedules`, `enrichment_cache`

### 2. Workorder Manager (paperwork printing)
Print-queue tool for shop documents.

- **Manual mode:** filter by status, select orders, print workorders + packing slips + box labels in one dialog
- **Auto-print mode:** scheduled engine (default 6h), generates PDFs (headless Chrome + HTML render), sends to printer via PrintNode, advances Printavo status, category→status routing
- **Printavo:** status-filtered fetches; status update mutation (write) · **Background:** auto-print cron · **DB:** `auto_print_config`, `print_jobs` · **3rd-party:** PrintNode

### 3. PO Builder (purchasing — identify & create)
Finds blanks that need ordering and builds POs.

- Scans Printavo invoices for "Needs Ordering" line items; staff build a combined PO, fetch live SanMar pricing, generate it
- Saves PO to DB; optionally writes PO back to Printavo as a production-file attachment + updates line-item/order status
- **Printavo:** two-pass scan (~50 pages); writes line-item status, order status, production file · **Background:** refresh every 20 min · **DB:** `po_files` · **3rd-party:** SanMar SOAP

### 4. Vendor Order Submission (purchasing — submit & track)
The downstream half of purchasing. Imports a PO from Printavo, submits it to the vendor, tracks status + shipping.

- Import PO from Printavo (or upload a vendor PDF via `pdf-parse`, or manual); per line item: vendor (SanMar/S&S), style+color → live inventory/pricing, warehouse selector, size/qty grid; submits + tracks vendor order #, status, tracking
- **Printavo:** GraphQL v2 PO browse; creds stored **in the DB** (`printavo_settings`) · **Vendors:** SanMar SOAP (`SubmitOrder`, `GetOrderStatus`, 9-warehouse inventory); S&S REST (working) · **DB:** `sanmar_orders`, `sanmar_line_items`, `sanmar_settings`, `ss_settings`, `printavo_settings`

### 5. Breezy Quote (quoting)
Per-piece decoration price calculator.

- Formula: `(Garment Cost × Markup) + Σ decoration costs`; named decoration matrices (qty × colors/stitches) shared in PostgreSQL; up to 4 locations; markup presets
- **Live vendor garment pricing:** S&S REST + SanMar SOAP, sale-price toggle; results per qty tier, copy + PNG export
- **DB:** `matrices` · **Secrets:** `SS_ACCOUNT_NUMBER`, `SS_API_KEY`, `SANMAR_USERNAME`, `SANMAR_PASSWORD`, `SANMAR_ACCOUNT_NUMBER` (164656) · **No Printavo yet**

### 6. Shipping Rate Estimator (shipping)
Side-by-side USPS/UPS rate quotes.

- Compares **ShipStation** (USPS via stamps_com, UPS reseller) and **EasyPost** (USPS + UPS on Mint's own linked accounts → real negotiated UPS discounts); box presets; weight calculator
- **Secrets:** `SHIPSTATION_API_KEY`, `SHIPSTATION_API_SECRET`, `EASYPOST_API_KEY` · **No Printavo yet** · No label purchase yet (EasyPost `Shipment.buy()` available, unbuilt)

### 7. PDF Sorter (shipping)
Sorts and matches packing slips to shipping labels before packing.

- Five presets (combine/sort/match); extracts order # + customer + style/color/size from slips, recipient/address/tracking from labels; matches "Last, First" ↔ "FIRST LAST" via token-set intersection
- **Python child process** (pdfplumber, pypdf, pandas) spawned by Express — required for layout-aware extraction · **Storage:** in-memory + `/tmp`, no DB · No Printavo API calls (extracted order # is a natural join key)

### 8. Printavo Backup (data)
Scheduled/on-demand full backup of the entire Printavo account.

- Backs up every entity (account, statuses, customers, contacts, products, invoices, quotes, transactions, tasks, threads, inquiries, merch stores, payment requests) + all binary files (mockups, artwork, PDFs); sample / incremental (`updatedAfter` watermarks) / full
- Dual-write to local disk + Dropbox; browse dashboard · **Rate limit:** 10 req/5s token bucket, complexity 25,000
- **Background:** node-cron · **DB:** `backup_config`, `backup_runs`, `entity_counts`, `backup_progress`, `entity_watermarks` · **Creds:** Printavo email+token **in the DB**; Dropbox OAuth **in the DB**

### 9. Reorder Portal — *NEW* (sales — **the only customer-facing app**)
A public portal where customers look up their order history and request reorders.

- Customer searches by **email or company name** → sees their order cards (mockup thumbnail, status, total, due date, pcs); opens a reorder modal with per-product size/qty grids (prefilled "was X" hints) + notes → submits
- **No database** — everything fetched **live** from Printavo GraphQL v2 (`invoices`, `lineItemGroups`, `imprints/mockups`), line items deduplicated server-side
- A reorder submission **emails the sales team** (`info@mintprintworks.com`) via **Resend** (Replit connector) — it does **not** persist anywhere today
- **Secrets:** `PRINTAVO_API_EMAIL`, `PRINTAVO_API_TOKEN`, `SESSION_SECRET`; Resend key fetched at runtime from the connector
- **Stack:** React + Vite + wouter + shadcn, Express, TanStack Query — same family as the rest

### 10. Color Reference DB — *NEW* (production reference)
Master color-matching database for the shop floor. Not Printavo-connected.

- Maps one **Pantone C** color → equivalent **Madeira Polyneon / Classic Rayon thread**, **Wilflex / house screen-print ink**, and **UltraColor DTF** — one source of truth across decoration methods
- ~**6,199 rows**; spreadsheet-style table, in-stock indicators, shelf locations; stock edits **auto-propagate** to every row sharing the same Pantone/thread/ink
- **Find Color Match:** server-side **Delta E CIE2000** (`/api/colors/match?r&g&b`) returns closest matches per system with ΔE scores; in-memory LAB cache invalidated on writes
- **DB:** `colors` table (PostgreSQL + Drizzle) · **Secrets:** `DATABASE_URL`, `SESSION_SECRET` (auth not implemented) · seeded from an Excel import script

---

## Why Consolidation Makes Sense

### Problem 1: Rate Limit Collision — two full crawlers + a live customer portal

Printavo enforces **10 requests per 5 seconds, shared across the entire account**. The Printavo-connected apps all share it:

| App | Printavo load | Throttle |
|---|---|---|
| Reporting | Full account crawl (~17k orders) twice daily | 550 ms/page |
| Backup | **Full account crawl + file downloads** (every entity) on cron | token bucket (10/5s) |
| Workorder Manager | Status-filtered fetches + auto-print cron | 600 ms/page |
| PO Builder | ~50-page two-pass scan every 20 min | 1,500 ms/page |
| Vendor Submission | PO browse (16 pages) on demand | per request |
| **Reorder Portal** | **Live customer lookups (15 invoices each) at unpredictable times** | per request |

There are **two independent full-account crawlers** (Reporting *and* Backup), plus a **public portal that fires Printavo queries whenever a customer searches** — outside your control. If the backup cron or reporting refresh overlaps a wave of customer lookups, they collectively blow the shared limit, causing 429s and failures across every tool *and* a slow experience for your customers. The PO Builder's very conservative 1,500 ms delay is almost certainly a scar from this. **One shared rate-limited queue** for the whole account is the fix: reports, backup, reorder scan, vendor sync, auto-print, *and* customer lookups all flow through it (mostly served from the shared cache).

### Problem 2: Duplicate Data Fetching
- **Two full crawls** of the same account (Reporting + Backup); every Printavo app fetches the **status list** independently
- PO Builder's scan, Vendor Submission's PO browse, and the Reorder Portal's customer lookups all traverse invoices the Reporting cache already holds
- Breezy, Vendor Submission, and PO Builder each maintain their **own SanMar/S&S clients**

### Problem 3: Purchasing is one pipeline split across two apps
PO Builder **finds + creates** the PO in Printavo; Vendor Submission **pulls it back, submits** to SanMar/S&S, and **tracks** shipping. Today staff finish in one app and re-key the PO into the other. Consolidated: one continuous **scan → build PO → submit → track** flow.

### Problem 4: Three apps integrate with the same two vendors
PO Builder, Breezy, and Vendor Submission **all** talk to SanMar (SOAP) and/or S&S (REST) — three implementations, three credential setups. One shared vendor layer centralizes pricing, SKU resolution, inventory, and submission. (The working S&S client in Vendor Submission/Breezy also resolves the S&S integration PO Builder couldn't finish.)

### Problem 5: The customer-facing portal is disconnected from operations
The Reorder Portal is your **first and only public app**. Today a reorder request just **emails sales and vanishes** — no record, no status, no link to the originating order in any internal tool. Consolidated, reorder requests are **captured in the shared database** and surface in an internal **Reorder Inbox** (triage: new → reviewed → quoted), tying customer demand directly into the purchasing and quoting workflows.

### Problem 6: Color matching is islanded from orders
The Color Reference DB holds the shop's entire Pantone→thread/ink/DTF mapping with Delta E matching, but it can't see Printavo orders. Inside the Hub, a Printavo order's specified color can resolve instantly to **in-stock** thread/ink across all decoration methods — avoiding production delays.

### Problem 7: Multiple schedulers
Independent timers in Reporting (refresh + email), Workorder (auto-print), PO Builder (20-min), and Backup (node-cron) must merge into one coordinated scheduler that never overlaps the backup full-crawl with the reporting refresh.

### Problem 8: Fragmented credentials & databases
Printavo creds live in **env vars** with three different names (`PRINTAVO_API_TOKEN`, `PRINTAVO_TOKEN`, **and now `PRINTAVO_API_EMAIL`**) **and** in **DB rows** (Backup's `backup_config`, Vendor Submission's `printavo_settings`). SanMar/S&S creds are similarly split. Each app has its own database. Consolidation establishes one credential source of truth and one database.

### Problem 9: Team & customer workflow friction
Staff juggle nine internal tools; customers use a tenth in isolation. One internal Hub (grouped sidebar) plus one public portal sharing the same data removes the friction on both sides.

---

## What Gets Shared vs. What Stays Separate

### Shared (one copy, both surfaces use it)

| Component | Notes |
|---|---|
| Printavo rate-limited fetch queue | One queue (10 req/5s) — internal jobs **and** public customer lookups route through it |
| Orders cache (memory + disk) | Serves reports, reorder scan, vendor PO browse, and customer lookups |
| v2 GraphQL enrichment crawl | Tags + pricing matrix for all features |
| Status list | Fetched separately by every Printavo app today |
| **Vendor layer (SanMar SOAP + S&S REST)** | One client for pricing, inventory, SKU resolution, submission |
| Coordinated scheduler | One timer: data refresh, email reports, auto-print, PO scan, backup cron |
| PostgreSQL database | One DB, all tables below (+ a new `reorder_requests` table for the portal) |
| Printavo credentials | One canonical source of truth |

### Unique (stays separate, becomes a module or the public surface)

| Feature | App | Cannot be collapsed because… |
|---|---|---|
| Ask AI | Reporting | OpenAI integration, unique UI |
| Scheduled email reports | Reporting | nodemailer, per-schedule DB config |
| PDF generation | Workorder | Puppeteer/Chromium headless browser |
| PrintNode delivery / auto-print | Workorder | Physical printer + category→status routing |
| Reorder scan + PO cart | PO Builder | Needs-Ordering scan, multi-order cart |
| Vendor submission + tracking | Vendor Submission | `SubmitOrder`/`GetOrderStatus`, warehouse logic |
| Decoration matrices + calculator | Breezy | Matrix CRUD, 4-location pricing, PNG export |
| Shipping rate comparison | Shipping | ShipStation + EasyPost, weight calc |
| PDF slip/label sorter | PDF Sorter | **Python** (pdfplumber/pypdf/pandas) subprocess |
| Full account backup + browse | Backup | Entity crawl + file download, Dropbox dual-write |
| **Customer reorder portal** | **Reorder Portal** | **Public access boundary — customers must never see internal data; stays a separate front-end** |
| Color matching (Delta E) | Color Reference DB | CIE2000 engine, 6,199-row dataset, LAB cache |

### Write Operations (still go directly to Printavo / vendors / email)
- Workorder: order status mutation · PO Builder: line-item/order status + production file · Vendor Submission: vendor order submission + status refresh · Reorder Portal: reorder email (→ becomes a DB write + email)

---

## Tech Stack Compatibility

Nearly identical stacks — the biggest reason consolidation is straightforward.

| | Reporting | Workorder | PO Builder | Vendor Sub | Breezy | Shipping | PDF Sorter | Backup | Reorder Portal | Color DB |
|---|---|---|---|---|---|---|---|---|---|---|
| Frontend | RV+T+shadcn | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (wouter) | ✓ (wouter) |
| Backend | Express+TS | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| DB client | Drizzle | raw `pg`→std. | Drizzle | Drizzle | Drizzle | (none) | none | Drizzle | none today | Drizzle |
| State | React Query | RQ | RQ+Zustand | RQ | RQ | RQ | RQ | RQ | TanStack Q | TanStack Q |
| Extra | — | Chromium | — | — | — | — | **Python 3** | node-cron | Resend | Delta E + LAB cache |

*(RV+T+shadcn = React + Vite + Tailwind + shadcn/ui; ✓ = same.)*

Standardizations needed: DB client → Drizzle everywhere (Workorder uses raw `pg`); include a **Python 3 runtime** (PDF Sorter) and **Chromium** (Workorder); add the **Resend** connector for the portal. Several apps already use a pnpm monorepo with OpenAPI→Orval codegen — a good target structure for the combined repo (one `api-server`, two front-end artifacts, shared `lib/` packages).

---

## Data Model & Config Conflicts to Resolve Before Building

| Item | Concern |
|---|---|
| **Revenue formula** | `unit_cost × total_quantities` (verified against `order_total`). Same everywhere. |
| **Category derivation** | Line-item-level. Derive from `lineitems[].category`. |
| **Imprints calculation** | `Σ (group quantity × imprint locations)`. Requires v2 enrichment. |
| **Status name parsing** | Strip the agency prefix up to the first ` - ` (`"Seps.io - 👕🧢 Name"`). |
| **Printavo v2 field quirks** | `companyName` not `name`; `nickname` not `orderNickname`; `invoices` not `orders`; `sortDescending: true`; mockup is `fullImageUrl`; size keys are enums (`size_m`…) → use a label map; `vendor { name }` on PurchaseOrder is broken. |
| **Printavo credential location & naming** | `PRINTAVO_API_TOKEN` vs `PRINTAVO_TOKEN`, plus `PRINTAVO_API_EMAIL` (portal), plus DB rows (`backup_config`, `printavo_settings`). Pick one source of truth. |
| **SanMar / S&S credential naming** | Three different SanMar var sets and two S&S sets across apps. Standardize one each. |
| **Reorder request persistence** | Portal currently only emails. Add a `reorder_requests` table so the internal Reorder Inbox can triage (new/reviewed/quoted) and link to the source order. |
| **Color match dataset** | 6,199 rows + per-row LAB cache invalidated on writes. Decide whether to map Printavo order colors → in-stock thread/ink (integration) or keep the library standalone in v1. |

---

## Proposed System Structure

### Two surfaces, one backend

| Surface | Audience | Modules |
|---|---|---|
| **Printavo Hub** (internal) | Managers / staff | Dashboard, Reports, Ask AI, **Reorder Inbox**, Reorder Scan, Vendor Orders, Print Queue, **Color Library**, Price Calculator, Rate Estimator, Label Sorter, Backups, Settings |
| **Reorder Portal** (public) | Customers | Order lookup + reorder request (writes to the shared `reorder_requests` table → appears in the internal Reorder Inbox) |

### Internal navigation (grouped sidebar)

| Group | Module | Source App |
|---|---|---|
| — | **Dashboard** | New |
| Analyze | Reports · Ask AI | Reporting |
| Sales | **Reorder Inbox** | Reorder Portal (internal triage side) |
| Purchasing | Reorder Scan · Vendor Orders | PO Builder · Vendor Submission |
| Production | Print Queue · **Color Library** | Workorder · Color Reference DB |
| Quoting | Price Calculator | Breezy |
| Shipping | Rate Estimator · Label Sorter | Shipping · PDF Sorter |
| Data | Backups | Printavo Backup |
| — | Settings | All |

### Architecture

```
                          Customers                       Staff
                              │                              │
                    ┌─────────▼─────────┐        ┌───────────▼───────────┐
                    │  Reorder Portal   │        │   Printavo Hub (SPA)  │
                    │   (public SPA)    │        │  grouped sidebar nav  │
                    └─────────┬─────────┘        └───────────┬───────────┘
                              │                              │
   ┌──────────────────────────▼──────────────────────────────▼──────────────────────┐
   │            One Express backend (Reserved VM) + Python 3 sidecar                  │
   │  ┌──────────────────────────────────────────────────────────────────────────┐  │
   │  │  Shared Printavo Data Layer — one queue (10/5s) · cache · enrichment ·     │  │
   │  │  one scheduler   |   Shared Vendor Layer (SanMar SOAP + S&S REST)          │  │
   │  └──────────────────────────────────────────────────────────────────────────┘  │
   │   Reports/AI · Reorder Inbox · Purchasing · Print · Color · Quote · Ship · Backup│
   └──────────────────────────────────────┬──────────────────────────────────────────┘
                                           ▼
                              One PostgreSQL database
```

### Infrastructure
- **One Reserved VM** (background crawlers, backup cron, schedulers break on autoscale; Shipping/Breezy move under it), with **Python 3** + **Chromium**
- **Two deployed front-ends** sharing the one backend: internal Hub (behind staff auth) and public Reorder Portal
- **One PostgreSQL database** — all existing tables plus a new `reorder_requests` table and the 6,199-row `colors` table
- **One canonical credential store** for Printavo, SanMar, S&S, ShipStation, EasyPost, Dropbox, PrintNode, OpenAI, Resend

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Two full crawlers + cron + live public lookups | **High** | The core win — serialize all Printavo traffic through one queue + scheduler; the portal reads cache, never overlaps backup/reporting. |
| Public access boundary (customer surface) | **High** | The portal must never expose internal data or staff routes. Keep it a separate front-end with its own restricted API scope; staff Hub behind auth. |
| Backup file-download volume | Medium | Full backups pull all artwork/PDFs — size VM disk + bandwidth; keep Dropbox dual-write. |
| Python + Chromium in one image | Medium | Confirm both run on the Reserved VM; profile memory. |
| Vendor layer unification | Medium | Merge three SanMar/S&S implementations — reconcile field mappings + warehouse codes before cutover. |
| Credential migration (DB ↔ env) | Medium | Backup + Vendor Sub read creds from DB; portal adds `PRINTAVO_API_EMAIL`. Migrate to one source carefully. |
| Color dataset + LAB cache | Low | 6,199 rows is small; preserve the in-memory LAB cache + invalidation on writes. |
| `.cache/` wipe on redeploy | Low | Enrichment survives in Postgres; orders re-crawl in minutes. |
| Prod DB preservation | Low | Never overwrite production data on publish. |

---

## Recommended Build Sequence

1. Set up the consolidated repo (pnpm monorepo: one `api-server`, **two** front-end artifacts — internal Hub + public Portal — shared `lib/` packages)
2. Unify the database schema (all tables + new `reorder_requests` + `colors`, Drizzle ORM) and pick one credential store
3. Port the Printavo data layer from Reporting as the shared core (queue + cache + enrichment)
4. Build the shared vendor layer (SanMar SOAP + S&S REST) from the three existing implementations
5. Merge all schedulers into one coordinated timer (including the backup cron)
6. Add Python 3 + Chromium runtimes; wire the PDF Sorter subprocess and Workorder PDF generation
7. Port internal modules: Reports/AI, Purchasing (scan + submit/track), Print Queue, Color Library, Breezy, Shipping, Backup
8. Build the public Reorder Portal front-end against the shared backend; persist reorder requests → internal Reorder Inbox (+ keep the Resend email)
9. Build the internal Hub front-end with grouped sidebar; standardize data-model definitions
10. Deploy: one Reserved VM, two front-ends, all secrets; verify backup + auto-print + crawls + public lookups don't collide

---

## Decision Checklist Before We Build

**Architecture & access**
- [ ] Keep the **Reorder Portal as a separate public surface** sharing one backend (recommended), and add an internal **Reorder Inbox** that persists + triages requests — instead of email-only?
- [ ] Does the internal Hub need staff login/auth (currently none of the internal apps appear to enforce it)?

**Credentials & integrations**
- [ ] **Printavo:** one canonical email + token (migrate the copies in `backup_config` / `printavo_settings`, and reconcile `PRINTAVO_API_EMAIL`)?
- [ ] **SanMar / S&S:** which credential sets are current (env-var variants vs DB rows)?
- [ ] **Shipping:** ShipStation + EasyPost keys available? **PrintNode** key + printer confirmed? **Dropbox** dual-write kept? **OpenAI** for Ask AI? **Resend** connector for the portal?

**Infrastructure**
- [ ] Deploy as one **Reserved VM** with **Python 3** + **Chromium**, serving **two** front-ends?
- [ ] Disk/bandwidth budget for full backups acceptable on the VM?

**Data migration (per app: migrate vs. start fresh)**
- [ ] Email report schedules · auto-print config · PO history · vendor orders · decoration matrices · backup runs/watermarks · **the 6,199-row color database**

**Scope & priority**
- [ ] Build all modules at once, or phase it (e.g. Purchasing pipeline + Reorder Inbox first)?
- [ ] Wire optional Printavo cross-links now (color match on an order line, shipping ship-to from an order, PDF Sorter enrichment, quote → Printavo order) or keep modules standalone in v1?

---

## What This Does Not Include
- No new Printavo features beyond what the ten existing apps already do (cross-links above are optional)
- The Reorder Portal stays the **only** public surface; the rest remain internal
- No real-time data (Printavo has no webhooks; polling/caching model unchanged)
- No shipping label *purchase* unless requested (EasyPost `Shipment.buy()` exists but isn't built today)

---

*End of assessment. Review with your team before approving the build plan.*
