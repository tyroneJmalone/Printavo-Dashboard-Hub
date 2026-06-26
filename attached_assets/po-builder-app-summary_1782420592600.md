# PO Builder — App Summary for Dashboard Integration

## What This App Does

PO Builder is an internal tool for a screen printing / apparel decoration shop that uses **Printavo** as their shop management system. Its sole job is to help staff quickly generate **Purchase Orders** (POs) for blank goods that need to be ordered from vendors.

The workflow:
1. The app scans all Printavo invoices to find orders where at least one line item has a **"Needs Ordering"** product status.
2. Staff select individual line items across multiple orders to build a combined PO.
3. They choose a vendor (SanMar or S&S Activewear), optionally pull live pricing from SanMar's API, enter a PO number and notes, and generate the PO.
4. The generated PO is saved to a local database, can be printed/exported, and is optionally pushed back to Printavo as a production file attachment on the relevant invoices.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces |
| Frontend | React + Vite + TypeScript |
| UI | Tailwind CSS + shadcn/ui components |
| State | Zustand (`use-po-store`) |
| Backend | Node.js + Express + TypeScript (tsx) |
| Database | PostgreSQL (via `DATABASE_URL` env var) |
| API contract | OpenAPI 3.1 spec → auto-generated Zod schemas + React Query hooks |
| Printavo | GraphQL API (`https://www.printavo.com/api/v2`) |
| SanMar | SOAP/XML API (`ws.sanmar.com:8080`) |
| S&S Activewear | Planned — currently blocked by Cloudflare (returns 503) |

**Artifacts (services):**
- `artifacts/api-server` — Express REST API running on port 8080
- `artifacts/po-builder` — React/Vite frontend (port from `$PORT` env var)

---

## Printavo Integration Details

### Authentication
The Printavo GraphQL API uses email + token headers (not Bearer tokens):
```
POST https://www.printavo.com/api/v2
Headers: { email: "...", token: "..." }
Env vars: PRINTAVO_EMAIL, PRINTAVO_TOKEN
```

### Known Printavo API Constraints
These are confirmed via GraphQL introspection and matter for any new integration:

- **No `updatedAt` field on Invoice** — the Invoice type does not expose an `updatedAt` field. Filtering by "recently changed" is not possible via the API.
- **`invoices` sort options** are limited to: `CUSTOMER_DUE_AT`, `CUSTOMER_NAME`, `STATUS`, `OWNER`, `TOTAL`, `VISUAL_ID` — there is **no `UPDATED_AT` sort**.
- **Query complexity limit: 25,000** — deeply nested queries fail hard. Safe nesting: `lineItemGroups(first: 5) { lineItems(first: 8) }` per page of 25 invoices.
- **Rate limiting** — 429s occur under ~1500ms page intervals. The app uses `PAGE_DELAY_MS = 1500ms` between pages and retries after `RATE_LIMIT_RETRY_WAIT_MS = 8000ms`.

### Two-Pass Scan Architecture
Because Needs Ordering items are scattered throughout invoice history (not clustered in recent orders), the app scans all 50 pages (1,250 invoices):

**Pass 1 — Slim scan** (`SCAN_QUERY`): fetches only `id + productStatus` per line item, ~330ms/page. Identifies which invoice IDs have a matching line item.

**Pass 2 — Full fetch** (`INVOICE_BY_ID_QUERY`): fetches complete invoice data only for matched IDs, in parallel batches of 5. Much faster than fetching all fields for all invoices.

- `PAGE_SIZE = 25`, `MAX_PAGES = 50`, `PAGE_DELAY_MS = 1500`
- Full scan takes **~90 seconds**
- Early termination was tried and removed — matches appeared at pages 3, 11, and 34 in the same scan

### Scan Caching & Background Refresh
- In-memory cache (`Map<string, CacheEntry>`), `CACHE_TTL_MS = 25 minutes`
- `startScheduledRefresh()` runs on server startup: triggers an immediate scan after 5 seconds, then again every 20 minutes
- Silent refresh: `scanPartialResult` stays `null` during auto-refresh so in-flight API requests return cached data rather than a spinner
- User-triggered refresh (`?refresh=true`): clears cache, shows live progress via polling
- Polling: frontend polls every 2 seconds while `scanning: true` in the response

### Status Filtering (Client-Side Only)
Printavo status names in this account carry an agency prefix: `"Seps.io - 👕🧢 Need 2 Order"`. The app strips everything up to and including the first ` - ` before comparing.

Predefined "Needs Ordering" status labels (hardcoded in the frontend):
```
👕🧢 Need 2 Order
🤑👕🧢 Need 2 Order - VENDOR SPECIAL PRICING
🔥📅 👕🧢 Need 2 Order - RUSH/FIRM DEADLINE/MAKEUP!
➕👕🧢 Need 2 Order - ADD ON
🏠👕🧢 Need 2 Order - PARTIAL IN-HOUSE
❗👕🧢 Need 2 Order - STOCK ISSUE/BACKORDER
```
Any result status not matching these labels appears as a dynamic "Other" pill.

---

## REST API Endpoints

Base path: `/api`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/printavo/orders` | Scan for Needs Ordering line items. Returns paginated orders + scan state. Supports `?after=<cursor>`, `?refresh=true` |
| `GET` | `/printavo/statuses` | All order statuses defined in this Printavo account |
| `PATCH` | `/printavo/line-item/:id/status` | Update a line item's product status (e.g. `need_ordering` → `ordered`) |
| `PATCH` | `/printavo/order/:id/status` | Update an invoice's order status by Printavo status ID |
| `GET` | `/printavo/vendor-pricing` | Fetch live pricing from a vendor API. `?vendor=sanmar&style=PC61&color=Athletic+Heather` |
| `POST` | `/printavo/purchase-order` | Generate a PO from selected line items. Saves to DB. Returns HTML-rendered PO. |
| `POST` | `/printavo/push-to-printavo` | Attach the PO HTML as a production file on each related Printavo invoice |
| `GET` | `/printavo/po-log` | All previously generated POs from DB |
| `PATCH` | `/printavo/po-log/:id` | Edit PO metadata (number, vendor, notes) |

### Key Response Shapes

**`GET /printavo/orders`** response:
```json
{
  "orders": [ /* Order[] */ ],
  "hasNextPage": false,
  "endCursor": null,
  "totalCount": 4,
  "scanning": false,
  "pagesScanned": 50,
  "refreshedAt": "2026-06-25T18:58:31.281Z"
}
```
While scanning: `scanning: true`, orders accumulate, client polls.

**`Order` object:**
```json
{
  "id": "gid://printavo/Invoice/12345",
  "visualId": "22177",
  "nickname": "Summer Camp Tees",
  "customerName": "Cam Cook",
  "createdAt": "2026-05-01T...",
  "dueAt": "2026-07-13",
  "customerDueAt": "2026-07-13",
  "url": "https://app.printavo.com/orders/22177",
  "statusId": "gid://printavo/Status/99",
  "statusName": "Seps.io - 👕🧢 Need 2 Order",
  "lineItems": [ /* LineItem[] — only those with Needs Ordering status */ ]
}
```

**`LineItem` object:**
```json
{
  "id": "gid://printavo/LineItemGroup/...",
  "name": "PC61",
  "description": "Port & Company Essential T-Shirt",
  "quantity": 72,
  "unitCost": null,
  "status": "need_ordering",
  "style": "PC61",
  "color": "Athletic Heather",
  "product": "Unisex Essential Tee",
  "brand": "Port & Company",
  "sizes": [
    { "id": "...", "name": "S", "quantity": 12 },
    { "id": "...", "name": "M", "quantity": 24 }
  ]
}
```

---

## SanMar Integration

- **Protocol:** SOAP/XML over HTTPS
- **Endpoint:** `https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort`
- **Operation:** `getProductInfoByStyleColorSize`
- **Env vars:** `SANMAR_CUSTOMER`, `SANMAR_USER`, `SANMAR_PASS`
- **Pricing fields to use:** `pieceSalePrice` / `dozenSalePrice` (account net cost after pricing tier). **Do NOT use** `piecePrice` / `dozenPrice` — those are MSRP/list price.
- In the UI, "Fetch SanMar Prices" button appears only when vendor = SanMar. It deduplicates by style+color and updates unit costs in the cart in-place.

---

## Database

PostgreSQL, accessed via `DATABASE_URL` env var. Managed with Drizzle ORM.

**`po_files` table:**
```sql
CREATE TABLE po_files (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number  TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  notes      TEXT,
  total_quantity INTEGER NOT NULL,
  total_cost NUMERIC NOT NULL,
  line_items JSONB NOT NULL,   -- full SelectedLineItem[] snapshot
  html_content TEXT NOT NULL,  -- rendered HTML of the PO at time of creation
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Schema source: `lib/db/src/schema/`

---

## Frontend State (Zustand)

Store: `use-po-store` — holds the "PO cart" of selected line items across the session.

Key state:
- `selectedItems: Record<lineItemId, SelectedLineItem>` — items checked by the user
- `generatedPo` — the created PO response (triggers the preview modal)

Usage rule: always select individual fields, never destructure the store:
```ts
const selectedItems = usePoStore((state) => state.selectedItems); // correct
const { selectedItems } = usePoStore(); // WRONG — breaks reactivity
```

---

## Frontend Pages

| Route | Component | Purpose |
|---|---|---|
| `/` | `home.tsx` | Main order list, status filter pills, PO cart sidebar |
| `/po-log` | `po-log.tsx` | History of all generated POs with reprint/push actions |

**PO Preview Modal** appears after a PO is built. Contains:
- Rendered PO preview (HTML)
- Print button (browser print dialog)
- "Push to Printavo" button — attaches PO as a production file on each related invoice

---

## Secrets / Environment Variables

| Variable | Used By | Purpose |
|---|---|---|
| `PRINTAVO_EMAIL` | API server | Printavo GraphQL auth |
| `PRINTAVO_TOKEN` | API server | Printavo GraphQL auth |
| `SANMAR_CUSTOMER` | API server | SanMar SOAP auth |
| `SANMAR_USER` | API server | SanMar SOAP auth |
| `SANMAR_PASS` | API server | SanMar SOAP auth |
| `SS_ACCOUNT` | API server | S&S Activewear (planned, blocked) |
| `SS_API_KEY` | API server | S&S Activewear (planned, blocked) |
| `DATABASE_URL` | API server | PostgreSQL connection |
| `PORT` | Both services | Port binding (set by Replit per artifact) |

---

## What Works / What Doesn't

| Feature | Status |
|---|---|
| Printavo invoice scan | ✅ Working — full 50-page scan, ~90s cold, instant from cache |
| Status filter pills | ✅ Working — 6 predefined + dynamic "other" pills |
| PO cart (multi-order) | ✅ Working |
| SanMar live pricing | ✅ Working |
| PO generation + HTML render | ✅ Working |
| PO saved to DB / PO History | ✅ Working |
| Push PO to Printavo as production file | ✅ Working |
| Line item status update after ordering | ✅ Working (API exists) |
| S&S Activewear pricing | ❌ Blocked — Cloudflare returns 503 on their API |
| Background auto-refresh every 20 min | ✅ Working |
| "Updated X min ago" timestamp | ✅ Working |

---

## Integration Notes for Dashboard

- The API server exposes a clean REST API — a dashboard could consume `/api/printavo/orders` directly with the same Printavo credentials.
- The scan result is cached in-memory on the API server process — if this app runs alongside others in a dashboard, each service would maintain its own independent cache unless they share the API server.
- The Printavo account uses emoji-heavy, agency-prefixed status names (e.g. `"Seps.io - 👕🧢 Need 2 Order"`). Any integration reading status names must strip the `"Agency - "` prefix before parsing.
- There is no `updatedAt` on Printavo invoices — real-time change detection requires polling or webhooks (Printavo webhook support should be evaluated separately).
- The PostgreSQL DB (`po_files` table) is local to this Replit project — a dashboard would either need to share the DB connection string or treat PO history as a separate data source.
