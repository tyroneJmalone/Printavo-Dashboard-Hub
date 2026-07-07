---
name: Printavo reporting formulas & data model
description: Exact revenue/quantity formulas, enrichment attribution, filter semantics, and email schedule behavior from the Insights app that Hub reports must replicate
---

# Data sources (Insights app, to be replaced by Hub sync engine)
- Primary data via **REST v1** (`/api/v1/orders`, `/payments`, `/orderstatuses`, `/categories`; email+token as query params, 100/page, 550ms delay, retry w/ backoff on 429/5xx).
- **v2 GraphQL used only for "enrichment"**: tags + `pricingMatrixColumn { columnName, matrix { name } }` per imprint + lineItems `{ items, price }` per group. Crawled by VISUAL_ID in TWO passes (desc then asc), 25/page, up to 800 pages/pass, dedup by visualId.
- Whole dataset held in memory; persisted to `.cache/*.json` on disk + `enrichment_cache` single-row jsonb in Postgres. 5-min TTL; full refresh at 12:00 AM and 12:00 PM ET.
- **Key limitation the Hub fixes**: v1 `/orders` sorts by visual_id desc, so incremental refresh only catches NEW orders — status changes on old orders require a full re-crawl. (Hub's v2 `updatedAfter` solves this.)
- Enrichment save quality gate: never overwrite DB snapshot if new count < 90% of previous (guards against partial crawls). Worth porting anywhere a crawl can silently stop early.

# Revenue / quantity formulas (must replicate exactly in Hub)
- Order revenue = `parseFloat(order.order_total || order.total || "0")` — invoice total incl. tax; summed over filtered orders.
- Line item qty = `total_quantities` if numeric, else sum of size_xs…size_6xl, size_ys, size_ym, size_yxl, size_other.
- Order qty = sum of line item quantities.
- Customer name precedence: company → full_name → first+last.
- **Pricing-matrix (imprint) revenue attribution**: per lineItemGroup, groupRevenue = Σ(li.price × li.items); groupQty = Σ(li.items). Each imprint detail = "MatrixName: ColumnName". Revenue split EVENLY across the group's imprint details (groupRevenue / count). Duplicates deduped per order for the details list but each imprint gets its per-imprint revenue share in quantities.
- Imprint count per order = Σ quantity across pricing_matrix_quantities entries.
- Payments are **cash-basis**: Σ parseFloat(p.amount) bucketed by transaction_date — daily buckets when range ≤31 days, else ISO-Monday weekly. Payments are separate from order revenue (accrual). Hub needs both views.
- Percentages = value / totalFilteredRevenue, rounded to 0.1%.

# Filter semantics
- Multi-value params `||`-separated; `exclude` param lists which filters invert to exclusion.
- Filters: statuses (name, case-insensitive exact), categories, created/production/due date ranges, style number, brand, line-item category, min/max qty, min/max total, text search.
- Date strings parsed as LOCAL midnight (start) / 23:59:59.999 (end) to avoid UTC cutoff bugs.

# Report endpoints to port
orders(+stats), status-breakdown, pricing-matrix-breakdown, order-quantity-breakdown, imprints-by-tier, style-number-breakdown, brand-breakdown, color-breakdown, payments, payments/stats, filter-options, ask-ai.

# Scheduled email reports
- `report_schedules` table: id + sort_order + jsonb blob per schedule (name, frequency daily/weekly/monthly, hour, day_of_week/day_of_month, recipients, preset_filters, include_* section toggles, include_csv, last_sent_at).
- nodemailer SMTP via env: SMTP_HOST/PORT/USER/PASS/FROM.
- All timing in America/New_York. Fires when occurrence reached AND not yet sent this period (catch-up within period, never across periods). Never-sent schedules only catch up if they existed at the occurrence time (prevents surprise email right after creating a schedule).
- Scheduler builds reports by calling the app's own HTTP endpoints, then renders HTML email + optional CSV attachment.

# Hub porting notes
- v1 line-item fields (category, brand, style_number, size columns) must be mapped to v2 GraphQL LineItem equivalents in the sync engine — verify field availability in v2 before Stage 2.
- Enrichment two-pass crawl becomes unnecessary in Hub: add pricingMatrixColumn to the main sync queries instead.
- Payments: decide v2 source (invoice transactions) vs keeping v1 /payments for cash-basis reporting.
