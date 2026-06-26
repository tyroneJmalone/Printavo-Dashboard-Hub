# Printavo Dashboard Consolidation Assessment
**Prepared:** June 25, 2026
**Scope:** Consolidating three Replit apps into one unified internal dashboard

---

## Executive Summary

You currently operate three separate Replit applications — a Reporting/Analytics app, a Workorder Manager (paperwork printing), and a PO Builder (purchasing) — all connecting to the same Printavo account. Each app runs its own Printavo data fetcher, its own background scheduler, and its own database. This causes **active reliability problems today** (the apps are interfering with each other via a shared API rate limit) and creates unnecessary friction for your team (multiple logins, multiple tabs, no shared context between tools).

**Recommendation: Consolidate all three into one app.** The technical foundations are highly compatible, the primary data layer is already well-designed in the Reporting app, and the consolidation solves real problems beyond just UX convenience.

---

## The Three Apps

### 1. Reporting App (mintavoreports.replit.app)
An analytics and reporting dashboard for order data.

**What it does:**
- Fetches and caches all Printavo orders (up to ~17,000 records)
- KPI summary cards: Total Orders, Total Revenue, Total Quantity, Total Imprints, Avg Order Value
- Rich filtering: by status, category, style number, brand, color, customer, date ranges, quantity ranges, invoice total ranges, tags, pricing matrix
- Data breakdowns: by status, style number, brand, color, pricing matrix, quantity tier, imprints
- Payments received section with date filtering
- CSV export of filtered results
- "Ask AI" — natural language queries against your order data (powered by GPT)
- Scheduled email reports (daily/weekly/monthly, configurable recipients)

**Data fetched from Printavo:**
- All orders via REST v1 API (paginated, up to 200 pages)
- Enrichment data (tags, pricing matrix) via GraphQL v2 — a slow crawl (up to 30 min full run)
- Payment records via REST v1

**Background jobs:**
- Full data refresh at 12:00 AM and 12:00 PM Eastern
- Email report scheduler (with missed-send catch-up logic)

**Database tables:** `report_schedules`, `enrichment_cache`

---

### 2. Workorder Manager (paperwork printing app)
A print-queue management tool for generating and sending shop documents.

**What it does:**

*Manual Mode:*
- Filter orders by one or more Printavo statuses
- Select specific orders (individual or bulk)
- Print workorders, packing slips, and box labels — all in one print dialog instead of clicking into each order individually in Printavo

*Auto-Print Mode:*
- Scheduled background engine (configurable interval, default every 6 hours)
- Automatically detects new orders in configured statuses
- Generates PDFs (workorders via headless Chrome; packing slips/box labels via HTML render)
- Sends PDFs to a physical printer via PrintNode (cloud print service)
- Advances the order's Printavo status after successful printing
- Moves to an "error" status if printing fails
- Category-based routing: different order types (screen printing, embroidery, etc.) route to different target statuses

**Data fetched from Printavo:**
- Orders filtered by configured status IDs (not all orders — a targeted subset)
- Order details including line item groups, imprints, contact info, addresses

**Writes to Printavo:**
- Status update mutation (advances order after printing)

**Background jobs:**
- Auto-print cron (runs every N hours, configurable)

**Database tables:** `auto_print_config` (single-row settings), `print_jobs` (history log)

**Third-party integration:** PrintNode (physical printer delivery)

---

### 3. PO Builder (purchasing app)
A purchase order generation tool for blank goods procurement.

**What it does:**
- Scans all Printavo invoices to find line items flagged as "Needs Ordering"
- Staff select line items across multiple orders to build a combined PO
- Choose vendor (SanMar or S&S Activewear), fetch live pricing from SanMar's API
- Enter PO number and notes, generate the PO document
- PO is saved to the database and can be printed
- Optionally pushes the PO back to Printavo as a production file attachment on the relevant invoices

**Data fetched from Printavo:**
- Two-pass scan of 50 pages of invoices (~90 seconds cold, instant from cache)
  - Pass 1: slim scan for "Needs Ordering" product status
  - Pass 2: full detail fetch for matched invoices only

**Writes to Printavo:**
- Line item product status update (e.g., "need_ordering" → "ordered")
- Order status update
- Production file attachment (the generated PO HTML)

**Background jobs:**
- Auto-refresh every 20 minutes

**Database tables:** `po_files` (history of all generated POs)

**Third-party integrations:** SanMar SOAP/XML API (live pricing); S&S Activewear (planned, currently blocked)

---

## Why Consolidation Makes Sense

### Problem 1: Rate Limit Collision (happening right now)

Printavo enforces a limit of **10 requests per 5 seconds, shared across your entire account**. All three apps are on the same account, so they share this limit.

| App | Delay between pages |
|---|---|
| Reporting app | 550 ms |
| Workorder Manager | 600 ms |
| PO Builder | 1,500 ms (most conservative — likely a response to 429 errors) |

When the Reporting app does a full data refresh (especially at its scheduled 12am/12pm runs), it consumes the rate limit for several minutes. During this time, the Workorder Manager and PO Builder experience throttling, backoff delays, and potentially failed requests. **The apps are actively degrading each other.**

Consolidation means one rate-limited fetch queue for the entire account. All three apps read from a single shared cache instead of each making their own Printavo calls.

### Problem 2: Duplicate Data Fetching

Each app independently fetches overlapping data:

- All three fetch the **status list** from Printavo on their own
- The Reporting app and PO Builder both scan large portions of your order history
- The Reporting app already caches **all orders in memory** — the PO Builder's entire 90-second two-pass scan could be replaced by filtering that existing cache

Consolidation eliminates redundant fetching entirely.

### Problem 3: Three Separate Schedulers

Each app runs its own background timer:
- Reporting: two timers (data refresh + email reports)
- Workorder Manager: one cron job
- PO Builder: one refresh timer

Multiple schedulers on the same Printavo account can cause refresh collisions, duplicate API bursts, and race conditions. They must be merged into one coordinated scheduler.

### Problem 4: Three Separate Databases

Each app has its own PostgreSQL database with no shared context. A consolidated app uses one database with all five tables, enabling future features like cross-referencing PO history with order reports.

### Problem 5: Team Workflow Friction

Staff currently need to:
- Remember which tool does what
- Maintain separate browser tabs/logins
- Context-switch between apps mid-workflow (e.g., checking a report to decide which orders to print)

One app with a sidebar nav solves this.

---

## What Gets Shared vs. What Stays Separate

### Shared (one copy, all features use it)

| Component | Notes |
|---|---|
| Printavo rate-limited fetch queue | One queue, 550ms between pages, all API calls routed through it |
| Orders cache (50–150 MB in memory) | Reporting app's existing cache covers all three apps' read needs |
| v2 GraphQL enrichment crawl | Feeds tags and pricing matrix data to all features |
| Status list | All three fetch this separately today |
| Scheduler | One coordinated timer for: data refresh, email reports, auto-print cron, PO scan refresh |
| PostgreSQL database | One DB, five tables |
| Printavo credentials | One `PRINTAVO_EMAIL` + `PRINTAVO_API_TOKEN` pair |

### Unique (stays separate, becomes a tab/module)

| Feature | App | Cannot be collapsed because... |
|---|---|---|
| Ask AI | Reporting | OpenAI integration, unique UI |
| Scheduled email reports | Reporting | nodemailer, per-schedule DB config |
| PDF generation | Workorder | Puppeteer/Chromium, headless browser |
| PrintNode delivery | Workorder | Physical printer integration |
| Auto-print engine | Workorder | Complex category→status routing logic |
| PO cart (multi-order selection) | PO Builder | Zustand in-session state |
| SanMar live pricing | PO Builder | SOAP/XML vendor API |
| PO history + Printavo attachment | PO Builder | Unique write-back workflow |

### Write Operations (still go directly to Printavo)

- Workorder Manager: order status mutation after printing
- PO Builder: line item status update, order status update, production file attachment

---

## Tech Stack Compatibility

All three apps use nearly identical stacks — this is the biggest reason consolidation is straightforward.

| | Reporting | Workorder | PO Builder |
|---|---|---|---|
| Frontend | React + Vite + Tailwind + shadcn/ui | React + Vite + Tailwind + shadcn/ui | React + Vite + Tailwind + shadcn/ui |
| Routing | wouter | wouter | (to confirm) |
| Backend | Express + TypeScript | Express + TypeScript | Express + TypeScript |
| Database client | Drizzle ORM | raw `pg` → standardize | Drizzle ORM |
| State management | React Query | React Query | React Query + Zustand |

No framework mismatches. The only standardization needed is the DB client (Workorder Manager uses raw `pg`; standardize to Drizzle ORM).

---

## Data Model Conflicts to Resolve Before Building

| Item | Concern |
|---|---|
| **Revenue formula** | Use `unit_cost × total_quantities` (verified against `order_total` in Reporting app). All sections must use the same formula. |
| **Category derivation** | Category is line-item-level, not order-level. No `order.category` field. Derive from `lineitems[].category`. |
| **Imprints calculation** | `Σ (group quantity × imprint locations per group)`. Requires v2 enrichment data. |
| **Status name parsing** | Printavo names carry an agency prefix: `"Seps.io - 👕🧢 Name"`. Strip everything up to and including the first ` - ` before comparing. |
| **Credential env var name** | Reporting/Workorder use `PRINTAVO_API_TOKEN`; PO Builder uses `PRINTAVO_TOKEN`. Standardize to `PRINTAVO_API_TOKEN`. |

---

## Proposed App Structure

### Navigation
One app with a persistent sidebar, five sections:

| Section | Source App | What it contains |
|---|---|---|
| **Dashboard** | New | At-a-glance summary: KPI cards, cache status, scheduler health, quick links |
| **Reports** | Reporting | Full filter panel, breakdowns, CSV export, payments |
| **Print Queue** | Workorder | Manual print mode + Auto-print config + print job history |
| **Purchasing** | PO Builder | Needs Ordering scan + PO cart + PO history + SanMar pricing |
| **Ask AI** | Reporting | Natural language query interface |
| **Settings** | All | Printavo credentials, SMTP, printer setup, scheduled reports |

### Architecture

```
┌─────────────────────────────────────────────────────┐
│            One Express backend (Reserved VM)          │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │         Shared Printavo Data Layer            │   │
│  │  • One rate-limited fetch queue (550ms/page)  │   │
│  │  • One orders cache (memory + .cache/ disk)   │   │
│  │  • One v2 enrichment crawl (→ Postgres)       │   │
│  │  • One coordinated scheduler                  │   │
│  └──────────────┬────────────────────────────────┘   │
│                 │ server-side reads, zero extra calls  │
│     ┌───────────┼──────────┬───────────┐              │
│     ▼           ▼          ▼           ▼              │
│  Reports    PrintQueue  Purchasing  AskAI             │
│  API routes API routes  API routes  API route         │
└─────────────────────────────────────────────────────┘
                      │
┌─────────────────────────────────────────────────────┐
│              One React frontend                       │
│   Sidebar nav: Dashboard | Reports | Print | PO | AI │
└─────────────────────────────────────────────────────┘
```

### Infrastructure
- **One Reserved VM** (required — background crawlers and in-process cron break on autoscale)
- **One PostgreSQL database** with all 5 tables: `report_schedules`, `enrichment_cache`, `auto_print_config`, `print_jobs`, `po_files`
- **One set of Printavo credentials** (single Printavo account)

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Puppeteer/Chromium memory footprint | Medium | PDF generation + large orders cache need a well-sized Reserved VM. Profile before finalizing VM tier. |
| Scheduler merge | Medium | Carefully sequence all timers. Document full schedule before coding. |
| `.cache/` wipe on redeploy | Low | Already handled — enrichment survives in Postgres; orders re-crawl in minutes. |
| Prod DB data preservation | Low | On publish, never overwrite production data. Existing Reporting app rule applies everywhere. |
| PO cart state | Low | Zustand persists within a browser session; standard React SPA behavior. |
| S&S Activewear | None | Remains blocked (Cloudflare issue on their API). Out of scope. |

---

## Recommended Build Sequence

1. Set up consolidated repo structure (new artifact, shared API server)
2. Migrate and unify the database schema (all 5 tables, Drizzle ORM)
3. Port the Printavo data layer from the Reporting app as the shared core
4. Merge all schedulers into one coordinated timer
5. Add Print Queue backend routes + PrintNode + Puppeteer integration
6. Add Purchasing backend routes + SanMar SOAP client
7. Build unified React frontend with sidebar navigation
8. Standardize all data model definitions (revenue, category, imprints, status names)
9. Deploy as one Reserved VM with all required secrets

---

## Decision Checklist Before We Build

Please confirm the following before work begins:

- **[ ] Credentials:** One shared `PRINTAVO_EMAIL` + `PRINTAVO_API_TOKEN` for all three apps?
- **[ ] PrintNode:** `PRINTNODE_API_KEY` available and physical printer confirmed working?
- **[ ] SanMar:** `SANMAR_CUSTOMER`, `SANMAR_USER`, `SANMAR_PASS` available?
- **[ ] Reserved VM:** Able to deploy as Reserved VM (required for background jobs)?
- **[ ] Existing DB data:** Which tables need data migrated vs. starting fresh?
  - Scheduled email reports — migrate or recreate?
  - Auto-print config — migrate or reconfigure?
  - PO history — migrate or start clean?

---

## What This Does Not Include

- No new Printavo features beyond what the three existing apps already do
- No public-facing pages (remains an internal tool)
- No real-time data (Printavo has no webhooks; polling/caching model is unchanged)
- S&S Activewear integration remains blocked (out of scope)

---

*End of assessment. For questions or clarification, review with your development team before approving the build plan.*
