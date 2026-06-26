# Printavo Dashboard Consolidation Assessment
**Prepared:** June 26, 2026
**Scope:** Consolidating eight Replit apps into one unified internal dashboard ("Printavo Hub")

---

## Executive Summary

You currently operate **eight separate Replit applications**, most of which connect to the same Printavo account (`tyler@mintprintworks.com`). Several run their own Printavo data fetcher, their own background scheduler, and their own database. This causes **active reliability problems today** (the apps interfere with each other through a shared API rate limit) and creates real friction for your team (multiple logins, multiple tabs, no shared context, duplicated vendor integrations).

The eight apps fall into natural workflow groups:

| Group | Apps |
|---|---|
| **Analyze** | Reporting/Analytics, Ask AI (a feature of Reporting) |
| **Purchasing** | PO Builder (find & create POs), Vendor Order Submission (submit to SanMar/S&S + track) |
| **Production** | Workorder Manager (paperwork printing + auto-print) |
| **Quoting** | Breezy Quote (decoration price calculator) |
| **Shipping** | Shipping Rate Estimator (USPS/UPS rates), PDF Sorter (slip + label matching) |
| **Data** | Printavo Backup (full account archive) |

**Recommendation: Consolidate all eight into one app.** The technical foundations are highly compatible (nearly all share React + Vite + Tailwind + shadcn/ui, Express + TypeScript, PostgreSQL + Drizzle), the primary data layer is already well-designed in the Reporting app, three apps already integrate with the same two vendors (SanMar + S&S), and consolidation solves real problems beyond UX convenience — chiefly the rate-limit collisions caused by **two** independent full-account crawlers (Reporting and Backup) plus several smaller scanners all hitting one account.

---

## The Eight Apps

### 1. Reporting App (mintavoreports.replit.app)
Analytics and reporting dashboard for order data.

- Fetches and caches all Printavo orders (~17,000 records)
- KPI cards, rich filtering (status, category, style, brand, color, customer, dates, quantity/total ranges, tags, pricing matrix), breakdowns, payments, CSV export
- "Ask AI" — natural language queries against order data (GPT)
- Scheduled email reports (daily/weekly/monthly)
- **Printavo:** all orders via REST v1; enrichment (tags, pricing matrix) via GraphQL v2 (slow crawl, up to 30 min); payments via REST v1
- **Background jobs:** full refresh at 12am/12pm ET; email report scheduler
- **DB tables:** `report_schedules`, `enrichment_cache`

### 2. Workorder Manager (paperwork printing)
Print-queue tool for shop documents.

- **Manual mode:** filter by status, select orders, print workorders + packing slips + box labels in one dialog
- **Auto-print mode:** scheduled engine (default every 6h), detects new orders, generates PDFs (headless Chrome for workorders; HTML render for slips/labels), sends to printer via PrintNode, advances Printavo status, category→status routing
- **Printavo:** orders filtered by status IDs; status update mutation (write)
- **Background jobs:** auto-print cron
- **DB tables:** `auto_print_config`, `print_jobs`
- **Third-party:** PrintNode

### 3. PO Builder (purchasing — identify & create)
Finds blanks that need ordering and builds POs.

- Scans Printavo invoices for line items flagged "Needs Ordering"
- Staff select items across orders → build a combined PO, fetch live SanMar pricing, generate the PO
- Saves PO to DB; optionally writes the PO back to Printavo as a production-file attachment and updates line-item/order status
- **Printavo:** two-pass scan of ~50 pages; writes line-item status, order status, production file
- **Background jobs:** auto-refresh every 20 min
- **DB tables:** `po_files`
- **Third-party:** SanMar SOAP (live pricing); S&S was previously blocked here

### 4. Vendor Order Submission — *NEW* (purchasing — submit & track)
The downstream half of purchasing. Imports a PO from Printavo, submits it to the vendor, tracks status + shipping.

- Import PO from Printavo (browse unordered POs, or enter a visual PO number), or upload a vendor PDF (parsed via `pdf-parse`), or manual entry
- Per line item: vendor (SanMar / S&S / skip), style + color → live inventory/pricing lookup, warehouse selector, size/qty grid
- Submits order to vendor; tracks vendor order number, live status, tracking numbers; archive with note
- **Printavo:** GraphQL v2 — browses POs via `invoices/quotes → lineItems → poLineItem → purchaseOrder`; filters to `goodsStatus = not_ordered`/null. Credentials stored **in the DB** (`printavo_settings`)
- **Vendors:** SanMar SOAP (`SubmitOrder`, `GetOrderStatus`, inventory by warehouse — 9 locations); S&S REST (SKU resolution, submission, status/tracking — working, not blocked)
- **DB tables:** `sanmar_orders`, `sanmar_line_items`, `sanmar_settings`, `ss_settings`, `printavo_settings`
- **Quirks noted:** `vendor { name }` on PurchaseOrder is broken (omit it); no root `purchaseOrders` query; REST v1 returns 404 for this account

### 5. Breezy Quote — *NEW* (quoting)
Per-piece decoration price calculator.

- Formula: `(Garment Cost × Markup) + Σ decoration costs = Unit Price`
- **Decoration matrices:** named 2D pricing tables (qty tiers × colors/stitches/size), shared server-side in PostgreSQL, CRUD + CSV import + starter matrices
- Up to 4 decoration locations per quote; markup presets 1.0–2.0×
- **Live vendor garment pricing:** S&S REST (`api.ssactivewear.com/v2`) and SanMar SOAP (product info + pricing services), with sale-price detection toggle
- Results table per qty tier; copy-to-clipboard; PNG export
- **DB tables:** `matrices`
- **Secrets:** `SS_ACCOUNT_NUMBER`, `SS_API_KEY`, `SANMAR_USERNAME`, `SANMAR_PASSWORD`, `SANMAR_ACCOUNT_NUMBER` (164656)
- **No Printavo integration yet**

### 6. Shipping Rate Estimator — *NEW* (shipping)
Side-by-side USPS/UPS rate quotes.

- Enter destination + package → compares rates from **ShipStation** (USPS via `stamps_com`, UPS via reseller account) and **EasyPost** (USPS + UPS on Mint's own linked accounts, so UPS reflects real negotiated discounts)
- Ship-from is hardcoded (Nashua, NH); box-dimension presets; weight calculator (tees/sweatshirts/jackets/hats → lbs)
- **Secrets:** `SHIPSTATION_API_KEY`, `SHIPSTATION_API_SECRET`, `EASYPOST_API_KEY`
- **No Printavo integration yet.** No label purchase yet (EasyPost `Shipment.buy()` is available but not implemented)

### 7. PDF Sorter — *NEW* (shipping)
Sorts and matches packing slips to shipping labels before packing.

- Five presets: combine labels, sort slips, sort labels, sort both (+ match report CSV), match labels
- Extracts `order_number` (Printavo #), customer, style, color, size from slips; recipient/address/tracking from labels; matches across "Last, First" ↔ "FIRST LAST" via token-set intersection
- **Python child process** (pdfplumber, pypdf, pandas) spawned by Express — required for layout-aware extraction of Printavo's slip layout
- **Storage:** in-memory jobs, temp files in `/tmp` — stateless, no DB
- **No Printavo API calls** today, but the extracted Printavo order number is a natural join key

### 8. Printavo Backup — *NEW* (data)
Scheduled/on-demand full backup of the entire Printavo account.

- Connects to Printavo **GraphQL v2**, backs up every entity (account, statuses, customers, contacts, products, invoices, quotes, transactions, tasks, threads, inquiries, merch stores, payment requests) plus all binary files (mockups, production artwork, PDFs, work-order HTML)
- Modes: sample / incremental (uses `updatedAfter` watermarks) / full (downloads files)
- Dual-write to local disk + Dropbox; a browse dashboard reads the latest full run
- **Rate limit:** 10 req / 5 sec enforced client-side via token bucket; query-complexity limit 25,000
- **Background jobs:** node-cron scheduler (e.g. `0 2 * * *`)
- **DB tables:** `backup_config`, `backup_runs`, `entity_counts`, `backup_progress`, `entity_watermarks`
- **Secrets/creds:** Printavo email + token stored **in the DB** (`backup_config`); Dropbox OAuth (access + refresh tokens) in the DB

---

## Why Consolidation Makes Sense

### Problem 1: Rate Limit Collision — now worse with two full crawlers

Printavo enforces **10 requests per 5 seconds, shared across the entire account**. The Printavo-connected apps all share it:

| App | Printavo load | Throttle |
|---|---|---|
| Reporting | Full account crawl (~17k orders) twice daily | 550 ms/page |
| Backup | **Full account crawl + file downloads** (every entity) on cron | token bucket (10/5s) |
| Workorder Manager | Targeted status-filtered fetches + auto-print cron | 600 ms/page |
| PO Builder | ~50-page two-pass scan every 20 min | 1,500 ms/page |
| Vendor Submission | PO browse (16 pages invoices+quotes) on demand | per request |

There are now **two independent full-account crawlers** (Reporting *and* Backup). If the backup cron and the reporting refresh overlap — or either overlaps with a PO scan or vendor PO browse — they collectively blow through the shared limit, causing 429s, backoff, and failed requests across every tool. The PO Builder's very conservative 1,500 ms delay is almost certainly a scar from exactly this. **The apps are actively degrading each other.**

Consolidation means **one rate-limited fetch queue** for the whole account. Every feature — reports, backup, reorder scan, vendor sync, auto-print — reads through that single queue (and mostly from the shared cache), so the account is never hit by competing processes.

### Problem 2: Duplicate Data Fetching

- **Two full crawls** of the same account (Reporting + Backup) pulling overlapping data
- Every Printavo app fetches the **status list** independently
- PO Builder's 90-second scan and Vendor Submission's PO browse both traverse invoices/quotes that the Reporting cache already holds
- Breezy and Vendor Submission and PO Builder each maintain their **own SanMar/S&S clients**

Consolidation lets the reorder scan, vendor PO browse, and reporting all read one cache, and routes all SanMar/S&S calls through one shared vendor client.

### Problem 3: The two halves of purchasing are split across two apps

PO Builder **finds** items that need ordering and **creates** the PO in Printavo. Vendor Order Submission **pulls** that PO from Printavo, **submits** it to SanMar/S&S, and **tracks** shipping. Today a staff member finishes in one app and re-enters the same PO in another. Consolidated, this becomes one continuous **Purchasing** flow: *scan → build PO → submit to vendor → track delivery*, with no re-keying.

### Problem 4: Three apps integrate with the same two vendors

PO Builder, Breezy Quote, and Vendor Submission **all** talk to SanMar (SOAP) and/or S&S (REST) — three separate implementations of the same integrations, with three different credential setups. One shared vendor layer means one place to maintain pricing lookups, SKU resolution, inventory checks, and order submission. (Bonus: the working S&S REST client in Vendor Submission/Breezy resolves the S&S integration that PO Builder couldn't complete.)

### Problem 5: Multiple schedulers

Independent background timers run in Reporting (data refresh + email), Workorder (auto-print cron), PO Builder (20-min refresh), and Backup (node-cron). Uncoordinated, they cause refresh collisions and duplicate API bursts. They must merge into one coordinated scheduler that sequences the heavy jobs (never run the backup full-crawl and the reporting refresh at the same time).

### Problem 6: Fragmented credentials & databases

Printavo credentials live in **env vars** in some apps (`PRINTAVO_API_TOKEN` vs `PRINTAVO_TOKEN`) and **in the database** in others (Backup's `backup_config`, Vendor Submission's `printavo_settings`). SanMar/S&S creds are similarly split between env vars (Breezy) and DB rows (Vendor Submission). Each app has its own PostgreSQL database. Consolidation establishes one credential source of truth and one database.

### Problem 7: Team Workflow Friction

Staff juggle eight tools, separate tabs, and constant context-switching (check a report → decide what to print → scan reorders → submit to vendor → quote a new job → estimate shipping). One app with a grouped sidebar removes that friction.

---

## What Gets Shared vs. What Stays Separate

### Shared (one copy, all features use it)

| Component | Notes |
|---|---|
| Printavo rate-limited fetch queue | One queue (10 req/5s), all API calls routed through it |
| Orders cache (50–150 MB in memory + disk) | Reporting's cache serves reports, reorder scan, and vendor PO browse |
| v2 GraphQL enrichment crawl | Tags + pricing matrix for all features |
| Status list | Fetched separately by every Printavo app today |
| **Vendor integration layer (SanMar SOAP + S&S REST)** | One client for pricing, inventory, SKU resolution, order submission — used by Quoting + both Purchasing stages |
| Coordinated scheduler | One timer for: data refresh, email reports, auto-print, PO scan, **backup cron** |
| PostgreSQL database | One DB, all tables below |
| Printavo credentials | One canonical source of truth (one email + token) |

### Unique (stays separate, becomes a module)

| Feature | App | Cannot be collapsed because… |
|---|---|---|
| Ask AI | Reporting | OpenAI integration, unique UI |
| Scheduled email reports | Reporting | nodemailer, per-schedule DB config |
| PDF generation | Workorder | Puppeteer/Chromium headless browser |
| PrintNode delivery | Workorder | Physical printer integration |
| Auto-print engine | Workorder | Category→status routing |
| Reorder scan + PO cart | PO Builder | Needs-Ordering scan, multi-order cart |
| Vendor order submission + tracking | Vendor Submission | `SubmitOrder`/`GetOrderStatus`, warehouse logic, archive |
| Decoration matrices + quote calculator | Breezy | Matrix CRUD, 4-location pricing, PNG export |
| Shipping rate comparison | Shipping Estimator | ShipStation + EasyPost, weight calc, box presets |
| PDF slip/label sorter | PDF Sorter | **Python** (pdfplumber/pypdf/pandas) child process |
| Full account backup + browse | Backup | Entity crawl + file download, Dropbox dual-write |

### Write Operations (still go directly to Printavo / vendors)

- Workorder: order status mutation after printing
- PO Builder: line-item status, order status, production-file attachment
- Vendor Submission: order submission to SanMar/S&S; status/tracking refresh

---

## Tech Stack Compatibility

Nearly identical stacks — the biggest reason consolidation is straightforward.

| | Reporting | Workorder | PO Builder | Vendor Sub | Breezy | Shipping | PDF Sorter | Backup |
|---|---|---|---|---|---|---|---|---|
| Frontend | RV+T+shadcn | RV+T+shadcn | RV+T+shadcn | RV+T+shadcn | RV+T+shadcn | RV+T+shadcn | RV+T+shadcn | RV+T+shadcn |
| Backend | Express+TS | Express+TS | Express+TS | Express+TS | Express+TS | Express+TS | Express+TS | Express+TS |
| DB client | Drizzle | raw `pg` → std. | Drizzle | Drizzle | Drizzle | (none/Zod) | none (in-mem) | Drizzle |
| State | React Query | React Query | RQ + Zustand | React Query | React Query | React Query | React Query | React Query |
| Extra runtime | — | Chromium | — | — | — | — | **Python 3** | node-cron |

*(RV+T+shadcn = React + Vite + Tailwind + shadcn/ui.)*

Standardizations needed: DB client → Drizzle everywhere (Workorder uses raw `pg`); and the consolidated app must include a **Python 3 runtime** (pdfplumber, pypdf, pandas) for the PDF Sorter, plus **Chromium** for Workorder PDF generation. Several apps already use a pnpm monorepo with OpenAPI→Orval codegen, which is a good target structure for the combined repo.

---

## Data Model & Config Conflicts to Resolve Before Building

| Item | Concern |
|---|---|
| **Revenue formula** | Use `unit_cost × total_quantities` (verified against `order_total`). Same formula everywhere. |
| **Category derivation** | Line-item-level, not order-level. Derive from `lineitems[].category`. |
| **Imprints calculation** | `Σ (group quantity × imprint locations)`. Requires v2 enrichment. |
| **Status name parsing** | Printavo names carry an agency prefix (`"Seps.io - 👕🧢 Name"`). Strip up to the first ` - `. |
| **Printavo field quirks (v2)** | `companyName` not `name`; customer via `contact.customer`; qty is `items`; unit price is `price` (dollars); mockup URL is `fullImageUrl`; transactions have no `totalNodes`; `vendor { name }` on PurchaseOrder is broken — omit. |
| **Printavo credential location** | Split across env vars (`PRINTAVO_API_TOKEN` vs `PRINTAVO_TOKEN`) **and** DB rows (`backup_config`, `printavo_settings`). Pick one source of truth (recommend secrets, with a Settings UI). |
| **SanMar credential naming** | `SANMAR_CUSTOMER/USER/PASS` (PO Builder) vs `SANMAR_USERNAME/PASSWORD/ACCOUNT_NUMBER` (Breezy) vs DB `sanmar_settings` (Vendor Sub). Standardize one set. |
| **S&S credential naming** | `SS_ACCOUNT_NUMBER/SS_API_KEY` (Breezy) vs DB `ss_settings` (Vendor Sub). Standardize one set. |
| **Pricing matrices vs Printavo matrices** | Breezy stores its own decoration `matrices`; Printavo orders also carry pricing-matrix data via enrichment. Decide whether to keep them independent or sync. |

---

## Proposed App Structure

### Navigation
One app, persistent sidebar, grouped by workflow:

| Group | Module | Source App |
|---|---|---|
| — | **Dashboard** | New — KPIs, module grid, pipeline health, quick actions |
| Analyze | **Reports** | Reporting |
| Analyze | **Ask AI** | Reporting |
| Purchasing | **Reorder Scan** | PO Builder |
| Purchasing | **Vendor Orders** | Vendor Submission |
| Production | **Print Queue** | Workorder Manager |
| Quoting | **Price Calculator** | Breezy Quote |
| Shipping | **Rate Estimator** | Shipping Estimator |
| Shipping | **Label Sorter** | PDF Sorter |
| Data | **Backups** | Printavo Backup |
| — | **Settings** | All — credentials, SMTP, printer, schedules, vendor + shipping keys, Dropbox |

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                 One Express backend (Reserved VM)              │
│                + Python 3 sidecar (PDF Sorter)                 │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Shared Printavo Data Layer                 │  │
│  │  • One rate-limited fetch queue (10 req / 5 sec)        │  │
│  │  • One orders cache (memory + disk)                     │  │
│  │  • One v2 enrichment crawl  • One coordinated scheduler │  │
│  └───────────────┬────────────────────────────────────────┘  │
│  ┌───────────────┴────────────────────────────────────────┐  │
│  │        Shared Vendor Layer (SanMar SOAP + S&S REST)    │  │
│  └───────────────┬────────────────────────────────────────┘  │
│      ┌─────────┬─┴───────┬──────────┬─────────┬──────────┐    │
│      ▼         ▼         ▼          ▼         ▼          ▼    │
│   Reports  Purchasing  Print    Quoting   Shipping    Backup │
│   + AskAI  (scan+vendor) Queue  (Breezy) (rates+sort) (archive)│
└──────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────┐
│                      One React frontend                        │
│  Sidebar: Dashboard · Reports/AI · Purchasing · Production ·   │
│           Quoting · Shipping · Backups · Settings              │
└──────────────────────────────────────────────────────────────┘
```

### Infrastructure
- **One Reserved VM** (required — background crawlers, backup cron, and in-process schedulers break on autoscale; note that Shipping and Breezy currently deploy as autoscale and will move under the VM)
- **Python 3 runtime** alongside Node (for the PDF Sorter), plus **Chromium** (Workorder PDFs)
- **One PostgreSQL database** with all tables: `report_schedules`, `enrichment_cache`, `auto_print_config`, `print_jobs`, `po_files`, `sanmar_orders`, `sanmar_line_items`, `matrices`, `backup_config`, `backup_runs`, `entity_counts`, `backup_progress`, `entity_watermarks` (+ consolidated settings)
- **One canonical credential store** for Printavo, SanMar, S&S, ShipStation, EasyPost, Dropbox, PrintNode, OpenAI

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Two full crawlers + cron overlap | **High** | The core win — serialize all heavy Printavo jobs through one queue + scheduler; never overlap backup and reporting refresh. |
| Backup file-download volume | Medium | Full backups download all artwork/PDFs — large disk + bandwidth. Keep Dropbox dual-write; size VM storage accordingly. |
| Python + Chromium in one image | Medium | PDF Sorter needs Python; Workorder needs Chromium. Confirm both run on the Reserved VM and profile memory. |
| Vendor layer unification | Medium | Three SanMar/S&S implementations to merge into one client — reconcile field mappings and warehouse codes before cutover. |
| Credential migration (DB ↔ env) | Medium | Backup + Vendor Sub read creds from DB; others from env. Migrate to one source carefully to avoid auth outages. |
| Scheduler merge | Medium | Document the full timetable (refresh, email, auto-print, PO scan, backup cron) before coding. |
| `.cache/` wipe on redeploy | Low | Enrichment survives in Postgres; orders re-crawl in minutes. |
| Prod DB preservation | Low | Never overwrite production data on publish. |

---

## Recommended Build Sequence

1. Set up consolidated repo (pnpm monorepo: one API server, one React app, shared `lib/` packages)
2. Unify the database schema (all tables, Drizzle ORM) and pick one credential store
3. Port the Printavo data layer from Reporting as the shared core (queue + cache + enrichment)
4. Build the shared vendor layer (SanMar SOAP + S&S REST) from the three existing implementations
5. Merge all schedulers into one coordinated timer (including the backup cron)
6. Add Python 3 + Chromium runtimes; wire the PDF Sorter subprocess and Workorder PDF generation
7. Port module backends: Reports/AI, Purchasing (scan + vendor submit/track), Print Queue, Breezy, Shipping, Backup
8. Build the unified React frontend with grouped sidebar navigation
9. Standardize data-model definitions (revenue, category, imprints, status names, field quirks)
10. Deploy as one Reserved VM with all secrets; verify backup + auto-print + crawls don't collide

---

## Decision Checklist Before We Build

Please confirm the following:

**Credentials & access**
- [ ] **Printavo:** one canonical email + token for all features (and migrate the copies currently in `backup_config` / `printavo_settings`)?
- [ ] **SanMar:** which credential set is current (`SANMAR_CUSTOMER/USER/PASS`, `SANMAR_USERNAME/PASSWORD/ACCOUNT_NUMBER 164656`, or the DB `sanmar_settings`)?
- [ ] **S&S Activewear:** `SS_ACCOUNT_NUMBER` + `SS_API_KEY` confirmed (this replaces the blocked S&S work in PO Builder)?
- [ ] **Shipping:** `SHIPSTATION_API_KEY`, `SHIPSTATION_API_SECRET`, `EASYPOST_API_KEY` available?
- [ ] **PrintNode:** `PRINTNODE_API_KEY` available and printer confirmed working?
- [ ] **Dropbox:** keep the off-site backup dual-write (OAuth refresh token)?
- [ ] **OpenAI:** key for Ask AI available?

**Infrastructure**
- [ ] Deploy as one **Reserved VM** (required), with **Python 3** and **Chromium** runtimes?
- [ ] Disk/bandwidth budget for full backups (artwork + PDFs) acceptable on the VM?

**Data migration (per app: migrate vs. start fresh)**
- [ ] Scheduled email reports · Auto-print config · PO history · Vendor orders history · Decoration matrices · Backup run history / watermarks

**Scope & priority**
- [ ] Build all eight modules at once, or phase it (e.g. Purchasing pipeline first, Shipping later)?
- [ ] Wire the planned Printavo cross-links now (shipping pulls ship-to from an order; PDF Sorter enriches match report from Printavo; quote feeds a Printavo order) or keep modules standalone in v1?

---

## What This Does Not Include

- No new Printavo features beyond what the eight existing apps already do (cross-links above are optional, opt-in)
- No public-facing pages (remains an internal tool)
- No real-time data (Printavo has no webhooks; polling/caching model unchanged)
- No shipping label *purchase* unless requested (EasyPost `Shipment.buy()` exists but isn't built today)

---

*End of assessment. Review with your team before approving the build plan.*
