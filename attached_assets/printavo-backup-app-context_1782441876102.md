# Printavo Backup App — Integration Context

This document describes the architecture, data model, and API surface of the **Printavo Backup Dashboard** — a self-hosted backup and data-browsing tool for a Printavo print shop account. It is intended to give another agent enough context to plan an integration or combined dashboard with other Printavo-connected apps.

---

## What This App Does

Connects to the **Printavo GraphQL API v2** and performs scheduled or on-demand backups of the entire Printavo account to local disk and/or Dropbox. A built-in dashboard lets shop staff browse all backed-up data without touching Printavo directly.

**Printavo account:** `tyler@mintprintworks.com` (Mint Print Works)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces |
| Runtime | Node.js 24 |
| Language | TypeScript 5.9 |
| API server | Express 5 |
| Database | PostgreSQL + Drizzle ORM |
| Frontend | React + Vite + Tailwind + shadcn/ui |
| API contract | OpenAPI spec + Orval codegen (React Query hooks) |
| Scheduling | node-cron |
| Build | esbuild |

---

## Monorepo Package Structure

```
artifacts/api-server/     — @workspace/api-server   Express REST API + backup engine
artifacts/dashboard/      — @workspace/dashboard     React/Vite dashboard UI
lib/db/                   — @workspace/db            Drizzle ORM schema + PostgreSQL client
lib/api-spec/             — @workspace/api-spec      OpenAPI spec + Orval codegen config
lib/api-client-react/     — @workspace/api-client-react  Generated React Query hooks
lib/api-zod/              — @workspace/api-zod       Generated Zod validation schemas
```

---

## Database Schema (PostgreSQL via Drizzle)

### `backup_config`
Singleton row — Printavo credentials + storage settings.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | Always 1 |
| `email` | text | Printavo account email |
| `token` | text | Printavo API token (rotates every ~6 months) |
| `storage_path` | text | Absolute path to backup root directory |
| `dropbox_token` | text | Dropbox OAuth access token (short-lived, ~4h) |
| `dropbox_refresh_token` | text | Dropbox refresh token (long-lived) |
| `dropbox_folder` | text | Dropbox destination folder path |
| `cron_schedule` | text | cron expression (e.g. `0 2 * * *`) |
| `scheduler_enabled` | boolean | Whether the cron scheduler is active |

### `backup_runs`
One row per backup run.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | Auto-increment |
| `mode` | text | `sample` / `incremental` / `full` |
| `status` | text | `running` / `completed` / `failed` / `cancelled` |
| `run_dir` | text | Absolute path to the run's output directory |
| `total_records` | integer | Total records backed up |
| `total_files` | integer | Total binary files downloaded |
| `total_bytes` | integer | Total bytes of binary files |
| `manifest` | jsonb | Summary of entity counts per type |
| `started_at` | timestamp | |
| `completed_at` | timestamp | |
| `error` | text | Error message if failed |

### `entity_counts`
Per-entity stats per run.

| Column | Notes |
|---|---|
| `run_id` | FK → backup_runs |
| `entity` | e.g. `invoices`, `customers`, `transactions` |
| `record_count`, `file_count`, `file_bytes` | Counts for this entity |
| `completed_at` | When this entity finished |
| `errors` | JSON array of error strings |

### `backup_progress`
Real-time progress state, updated every 3 seconds during a run. Used by the dashboard's live progress bar.

### `entity_watermarks`
Stores the last `updatedAt` timestamp per entity type — used by incremental mode to filter only changed records.

---

## Printavo API Integration

**Endpoint:** `https://www.printavo.com/api/v2` (GraphQL)

**Auth:** HTTP headers `email` + `token` (not Bearer token)

**Rate limit:** 10 requests per 5 seconds — enforced client-side with a token bucket

**Query complexity limit:** 25,000 per request — nested pagination uses conservative limits:
- `lineItemGroups(first: 10)`, `lineItems(first: 25)`, `imprints(first: 20)`, `mockups(first: 5)`

**No webhooks** — incremental mode uses the `updatedAfter` argument on list queries

---

## What Data Is Backed Up

### Entity Types

| Entity | Notes |
|---|---|
| **Account** | Single account/user record |
| **Statuses** | All order statuses (name, color) |
| **Customers** | Company info, billing/shipping addresses, payment terms |
| **Contacts** | People linked to customers (name, email, phone) |
| **Products** | Product catalog (requires search query — fetched with empty search) |
| **Invoices** | Full order records including all nested data (see below) |
| **Quotes** | Same structure as invoices |
| **Transactions** | Payment, Refund, Void, Return, PaymentDispute union types |
| **Tasks** | Checklist tasks on orders |
| **Threads** | Message threads between staff and customers |
| **Inquiries** | Customer inquiry forms |
| **Merch Stores** | Online storefronts connected to the account |
| **Payment Requests** | Customer-facing payment links |

### Invoice / Quote Detail (Nested Structure)

Each invoice/quote is fetched individually and stored with full nesting:

```
invoice.json
  contact { customer { companyName, ... }, fullName, email, phone }
  status { name, color }
  lineItemGroups[]
    lineItems[]
      id, description, color, itemNumber, items (qty), price ($/unit)
      mockups[] { fullImageUrl, thumbnailUrl, mimeType }   ← line-item artwork
    imprints[]
      typeOfWork { name }
      pricingMatrixColumn { columnName, matrix { name, typeOfWork } }
      mockups[] { fullImageUrl, thumbnailUrl }             ← imprint artwork
      productionFiles[]                                    ← artwork files (AI, PDF, PSD, etc.)
  tasks[], threads[], fees[], transactions[], paymentRequests[], approvalRequests[]
```

### Important Printavo v2 Field Name Quirks

- Customer name field is `companyName` (not `name`)
- Invoice/Quote customer is accessed via `contact.customer` (no top-level `customer` field)
- Line item quantity is `items` (not `quantity`)
- Line item unit price is `price` in dollars (not cents, not `unitPrice`)
- Line item name is `description`
- Transaction connections do NOT have `totalNodes` — only `nodes` + `pageInfo`
- `defaultPaymentTerm` is an object `{ id, name, days }` — not a scalar
- Mockup image URL is `fullImageUrl` (not `url`)

---

## Backup Modes

| Mode | Behavior |
|---|---|
| **Sample** | Fetches 25 records per entity, no file downloads — used for testing |
| **Incremental** | Fetches only records updated since the last successful run (`updatedAfter` filter) |
| **Full** | Fetches all records + downloads all binary files (mockups, production files, PDFs, work orders) |

---

## On-Disk File Storage Layout

```
{storagePath}/{mode}/{YYYY-MM-DD_HH-MM-SS}/
  account.json
  statuses.json
  customers.json
  contacts.json
  products.json
  transactions.json
  tasks.json
  threads.json
  inquiries.json
  merch_stores.json
  payment_requests.json
  invoices/
    invoice_{visualId}/
      invoice.json
      invoice_{visualId}.pdf          ← PDF (from publicUrl + ".pdf")
      workorder_{visualId}.html       ← Work order HTML (from workorderUrl)
      line_item_groups/
        group_{id}/
          group.json                  ← line items + imprints + pricing matrix
          mockups/
            lineitem_{id}_mockup.jpg  ← line item artwork (fullImageUrl)
          imprints/
            {name}_{id}/
              mockup.jpg              ← imprint-level mockup
              artwork.ai              ← production file (original artwork)
  quotes/
    quote_{visualId}/
      (same structure as invoices)
```

**Storage providers:**
- **Local only** — files written to disk path
- **Dropbox** — dual-write: files saved locally (for dashboard browsing) AND uploaded to Dropbox (off-site backup). Dropbox token lives in `backup_config`, refreshed via Setup page.

---

## REST API Surface

The API server runs on port `8080` and mounts all routes under `/api`.

### Backup Control (`/api/backup/`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/backup/config` | Current credentials + storage config |
| `PUT` | `/api/backup/config` | Update credentials + storage config |
| `GET` | `/api/backup/status` | Running backup status + live progress |
| `POST` | `/api/backup/trigger` | Start a backup `{ mode: "sample"|"incremental"|"full" }` |
| `POST` | `/api/backup/cancel` | Cancel the running backup |
| `PUT` | `/api/backup/scheduler` | Enable/disable cron scheduler `{ enabled, schedule }` |
| `GET` | `/api/backup/progress/stream` | SSE stream for real-time progress updates |
| `GET` | `/api/backup/runs` | Paginated list of past backup runs |
| `GET` | `/api/backup/runs/:id` | Single run detail + entity counts |
| `GET` | `/api/backup/stats` | Aggregate stats across all runs |
| `POST` | `/api/backup/dropbox/store-token` | Store Dropbox OAuth token |
| `GET` | `/api/backup/dropbox/folders` | List Dropbox folders |

### Data Browse (`/api/data/`)

All browse endpoints read from the **latest completed full run** (falling back to sample). Incremental runs are never used as the base snapshot (they are delta-only).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/data/orders` | List invoices + quotes. Query: `search`, `customer`, `status`, `dateFrom`, `dateTo`, `limit`, `offset` |
| `GET` | `/api/data/orders/:visualId` | Full order detail with all line item groups, line items, imprints, pricing matrix, `pdfPath`, `workorderPath` |
| `GET` | `/api/data/customers` | List customers with order + contact counts |
| `GET` | `/api/data/customers/:id` | Customer detail with contacts + orders |
| `GET` | `/api/data/transactions` | List transactions with revenue aggregates |
| `GET` | `/api/data/files` | List files (mockups + production). Query: `orderId`, `type` (`mockup`|`production`), `dateFrom`, `dateTo`, `limit`, `offset` |
| `GET` | `/api/data/files/download` | Serve a file by absolute path. Query: `path` |

### Order Detail Response Shape

```json
{
  "id": "string",
  "type": "invoice" | "quote",
  "visualId": "string",
  "customerName": "string",
  "status": "string",
  "productionDate": "ISO string | null",
  "totalCents": "number | null",
  "createdAt": "ISO string",
  "pdfPath": "string | null",
  "workorderPath": "string | null",
  "lineItemGroups": [
    {
      "id": "string",
      "lineItems": [
        {
          "id": "string",
          "description": "garment name",
          "color": "Black",
          "itemNumber": "8000",
          "items": 19,
          "price": 8.00,
          "mockups": [{ "fullImageUrl": "...", "thumbnailUrl": "...", "mimeType": "..." }]
        }
      ],
      "imprints": [
        {
          "id": "string",
          "typeOfWork": { "id": "...", "name": "Screen Printing" },
          "pricingMatrixColumn": {
            "columnName": "3 color",
            "matrix": { "name": "Screen Printing - 8", "typeOfWork": { "name": "Screen Printing" } }
          },
          "mockups": [],
          "productionFiles": []
        }
      ]
    }
  ],
  "raw": { "...full flattened invoice/quote object..." }
}
```

---

## Dashboard Pages

| Page | Route | What It Shows |
|---|---|---|
| Overview | `/` | Live backup status, progress bar, trigger controls, run history, health check |
| Backups | `/backups` | Detailed run history with per-entity counts |
| Orders | `/orders` | Searchable/filterable table of all invoices + quotes. Detail panel shows line items, imprint locations, pricing matrix, inline mockup thumbnails, PDF/work order links |
| Customers | `/customers` | Customer list with order counts + contacts. Click-through to filtered orders |
| Financials | `/financials` | Transaction table with revenue aggregates, outstanding balance estimate |
| Files | `/files` | Full-text file gallery of mockups + production files across all orders |
| Setup | `/setup` | Guided first-run configuration (credentials, storage path, Dropbox OAuth) |
| Settings | `/settings` | Change credentials, schedule, storage backend |

---

## Key Implementation Notes for Integration

1. **Printavo API token** — stored in `backup_config.token`, separate from the email. Rotates every ~6 months. Both fields must be passed as HTTP headers `email` and `token` (not Authorization header).

2. **One backup at a time** — the engine uses a module-level `AbortController`; a second trigger is rejected with 409 if one is already running.

3. **Dashboard reads from latest full run only** — `resolveLatestRunDir()` in `data.ts` queries the DB for the most recent completed full-mode run, then falls back to sample. Incremental runs are intentionally excluded from browsing.

4. **GraphQL connection unwrapping** — raw backup files store Printavo's GraphQL `{ nodes: [...], pageInfo: {...} }` shape. The `flattenGroupConnections()` function in `data.ts` unwraps all connection fields to plain arrays before serving to the dashboard.

5. **File serving** — `/api/data/files/download?path=<absolute_path>` serves any file from within the configured `storagePath`. Path is validated to stay within `storagePath` to prevent directory traversal.

6. **Dropbox dual-write** — when `dropboxToken` is set, every file write (JSON, binary) goes to both local disk and Dropbox. Local copy is always required for dashboard browsing.

7. **No Printavo webhook support** — the only way to detect new/changed records is incremental mode (polling with `updatedAfter`). If real-time sync is needed across apps, a shared cron job or message bus would be required.

8. **Transaction union type** — Printavo's `transactions` connection returns a union of `Payment | Refund | Void | Return | PaymentDispute`. All share `amount`, `id`, `timestamps`, `transactionDate`. `PaymentDispute` additionally has `dispute*` fields. The connection object does NOT support `totalNodes`.
