# Printavo Workorder Manager — App Context

> Share this file with another agent to provide full context for integration planning.

---

## What This App Does

A React + Express web app that connects to a Printavo account (print shop order management SaaS) and solves two main problems:

1. **Manual Mode** — Filter orders by one or more statuses, select specific orders, and bulk-print workorders, packing slips, or box labels without clicking into each order individually in Printavo.
2. **Auto Print Mode** — A scheduled background engine that automatically detects new orders, generates PDFs, sends them to a physical printer via PrintNode, and optionally advances the order's Printavo status — all without human intervention.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite, TanStack Query v5, shadcn/ui, Tailwind CSS, Wouter routing |
| Backend | Node.js + Express (TypeScript via `tsx`) |
| Database | PostgreSQL (Replit-managed), accessed with raw `pg` Pool queries |
| Print delivery | PrintNode API (cloud print service — sends PDF jobs to a physical printer) |
| Printavo API | GraphQL v2 at `https://www.printavo.com/api/v2` |
| Scheduler | `node-cron` (runs auto-print on a configurable interval, default every 6 hours) |
| PDF generation | `puppeteer-core` + local Chromium (headless browser renders HTML → PDF) |

---

## Environment Variables / Secrets

| Secret | Purpose |
|---|---|
| `PRINTAVO_EMAIL` | Printavo account email — used as the `email` header on every GraphQL request |
| `PRINTAVO_API_TOKEN` | Printavo API token (from My Account page, valid 6 months) — used as the `token` header |
| `PRINTAVO_PASSWORD` | Web login password — only needed if using Puppeteer session auth (currently unused) |
| `PRINTNODE_API_KEY` | PrintNode API key — used to submit PDF print jobs to physical printers |
| `DATABASE_URL` | PostgreSQL connection string (auto-set by Replit) |
| `SESSION_SECRET` | Express session secret |

---

## Printavo API Integration

### Authentication
Every GraphQL request sends two headers:
```
email: <PRINTAVO_EMAIL>
token: <PRINTAVO_API_TOKEN>
```

### API Details
- **Endpoint**: `POST https://www.printavo.com/api/v2` (GraphQL only, no REST v2)
- **Rate limit**: 10 requests per 5 seconds
- **Pagination**: cursor-based, 25 orders per page by default; statuses use `first: 100`
- **Order types**: Orders are polymorphic — either `Invoice` or `Quote` (both use the same GraphQL fragment via inline fragments `... on Invoice { } ... on Quote { }`)

### What the App Reads From Printavo

**Statuses** (`getStatuses`): Fetches all custom order statuses (paginated). Returns `{ id, name, color, position }`.

**Orders** (`getOrdersByStatusIds` / `getAllOrdersByStatusIds`): Fetches orders filtered by one or more status IDs, sorted by `VISUAL_ID`. Returns per order:

```typescript
{
  id: string,           // Printavo internal GraphQL ID (opaque)
  visualId: number,     // Human-readable order number (e.g. 22040)
  nickname: string,     // Order name/description
  customerName: string, // From contact.fullName
  customerEmail: string,
  total: string,        // Dollar amount as string
  totalQuantity: number,
  orderStatus: string,  // Status name
  orderStatusColor: string,
  productionDate: string, // dueAt (internal production due date, ISO)
  dueDate: string,        // customerDueAt (customer-facing due date, ISO)
  workorderUrl: string,   // e.g. https://mintprintworks.printavo.com/work_orders/{hash}
  packingSlipUrl: string, // e.g. https://www.printavo.com/invoices/{id}/packing_slip
  invoiceUrl: string,     // e.g. https://www.printavo.com/invoices/{id}
  type: "Invoice" | "Quote"
}
```

**Order Details** (`getOrderDetails`): Fetches full detail for a single order including:
- Contact info (fullName, email, phone, company name)
- Billing and shipping addresses
- Line item groups (style name, style number, color, quantity, size breakdown)
- Imprints per group (name, typeOfWork/category, location, color count, description)

**Order Categories** (`getOrderWithCategories`): Lightweight query — fetches only the `typeOfWork.name` values across all imprints on an order. Used by the auto-print engine to route orders to the correct target status.

**Company Info** (`getCompanyInfo`): Fetches shop name, phone, email, website, and address. Cached in-memory for 1 hour.

**Status Updates** (`updateOrderStatus`): Runs a `statusUpdate` mutation to move an order to a new status.

### Known API Quirks

- Some fields (e.g. `lineItems[].qty`, address field names) may silently return null or differ from documented schema. The app uses a `graphqlRequestLenient` wrapper that returns partial data even when non-fatal GraphQL errors occur.
- `workorderUrl` returns a **public URL** — accessible without auth — at the shop's custom Printavo subdomain (e.g. `mintprintworks.printavo.com/work_orders/{random-hash}`). These can be fetched server-side freely.
- `packingSlipUrl` (`/invoices/{id}/packing_slip`) and box label URLs (`/invoices/{id}/box_labels`) are **session-protected** — they require a logged-in Printavo browser session and cannot be fetched server-side with API token auth. The app opens them in the user's browser instead.

---

## Database Schema (PostgreSQL)

### `auto_print_config` (single-row config table, id=1)

| Column | Type | Description |
|---|---|---|
| `enabled` | boolean | Whether auto-print scheduler is active |
| `schedule_hours` | integer | How often to run (1–24 hours, default 6) |
| `source_status_ids` | text | Comma-separated Printavo status IDs to pull orders from |
| `error_status_id` | text | Status to set on an order if printing fails |
| `printer_id` | text | PrintNode printer ID for workorders |
| `printer_name` | text | Human-readable printer name |
| `copies` | integer | Workorder copies to print |
| `dry_run` | boolean | If true, simulate without actually printing |
| `category_mappings` | jsonb | Array of `{ category, statusId, statusName }` — maps order type-of-work → target Printavo status after printing |
| `workorder_enabled` | boolean | Print workorder doc type |
| `packing_slip_enabled` | boolean | Print packing slip doc type |
| `packing_slip_printer_id` | text | PrintNode printer ID for packing slips |
| `packing_slip_copies` | integer | Packing slip copies |
| `box_label_enabled` | boolean | Print box label doc type |
| `box_label_printer_id` | text | PrintNode printer ID for box labels |
| `box_label_copies` | integer | Box label copies |

### `print_jobs` (history log)

| Column | Type | Description |
|---|---|---|
| `id` | serial | Primary key |
| `printavo_order_id` | text | Printavo GraphQL ID |
| `visual_id` | text | Human-readable order number |
| `nickname` | text | Order name |
| `source_status_id` | text | Status the order was in when printed |
| `target_status_id` / `target_status_name` | text | Status applied after printing |
| `printnode_job_id` | text | PrintNode job ID for tracking |
| `printer_id` | text | Printer used |
| `status` | text | `pending`, `processing`, `printed`, `failed`, `dry_run` |
| `error_message` | text | Error detail if failed |
| `dry_run` | boolean | Whether this was a simulated run |
| `is_reprint` | boolean | Whether this order had been previously printed |
| `printed_at` | timestamptz | When the print job was submitted |

---

## API Endpoints

### Manual Mode

| Method | Path | Description |
|---|---|---|
| GET | `/api/statuses` | Fetch all Printavo statuses (paginated, returns all) |
| GET | `/api/orders?statusIds=X,Y&all=true` | Fetch orders for given status IDs. `all=true` fetches every page automatically |
| POST | `/api/print-combined` | Body: `{ workorderUrls: string[] }`. Fetches each public workorder HTML page server-side, injects a `<base>` tag, concatenates into a single HTML page with CSS `page-break` between each, and returns it. The frontend opens this in a popup window for a single print dialog. Max 50. |
| POST | `/api/print-packing-slips` | Body: `{ packingSlipUrls: string[] }`. Returns an HTML launcher page the user opens in a popup — lists all packing slip URLs as clickable links to open in Printavo browser tabs (session auth required). |
| POST | `/api/print-box-labels` | Body: `{ boxLabelUrls: string[] }`. Same launcher page pattern as packing slips. Box label URL = `invoiceUrl + "/box_labels"`. |
| POST | `/api/orders/update-status` | Body: `{ orderIds: string[], statusId: string }`. Bulk status update via Printavo mutation. |

### Auto Print Mode

| Method | Path | Description |
|---|---|---|
| GET | `/api/autoprint/config` | Get current auto-print configuration |
| POST | `/api/autoprint/config` | Save configuration and reschedule cron |
| GET | `/api/autoprint/printers` | List PrintNode printers available to the account |
| GET | `/api/autoprint/jobs` | Last 50 print job history records |
| POST | `/api/autoprint/run-now` | Body: `{ dryRun: boolean }`. Trigger an immediate auto-print run |

---

## Auto-Print Engine Logic

When triggered (scheduled or manual):

1. Fetch all orders in the configured source statuses
2. For each order:
   - Check if already printed (skip if so, unless reprinting)
   - Call `getOrderWithCategories` to read its `typeOfWork` imprint categories
   - Look up the category in `categoryMappings` to find the target Printavo status
   - Generate PDFs for enabled doc types (workorder / packing slip / box label)
   - Submit each PDF to PrintNode with the configured printer and copy count
   - On success: update the Printavo order status to the mapped target status
   - On failure: move the order to the `errorStatusId` status (if configured)
3. Log each outcome to `print_jobs` table

### PDF Generation
- Uses `puppeteer-core` + local Chromium (hardcoded Nix path: `/nix/store/.../chromium`, with `CHROMIUM_EXECUTABLE_PATH` env override)
- Workorders: fetches the public `workorderUrl` HTML in headless Chrome, renders to PDF
- Packing slips / box labels: generates HTML from Printavo GraphQL data (company info + order details + line items), renders to PDF — because the actual Printavo packing slip/box label pages are session-protected and cannot be fetched server-side

### Category → Status Mapping
The `categoryMappings` config field is an array:
```json
[
  { "category": "Screen Printing", "statusId": "...", "statusName": "Ready for Pickup" },
  { "category": "Embroidery",      "statusId": "...", "statusName": "Embroidery Queue" },
  { "category": "__fallback__",    "statusId": "...", "statusName": "Default Status" }
]
```
The engine matches the first imprint category found on the order. `__fallback__` is used if no category matches.

---

## Frontend Features

### Manual Mode (`/`)
- **Multi-select status filter**: Toggle buttons for each Printavo status (colored to match). Preset buttons: All, Active (hardcoded common statuses), None.
- **Production date filter**: Client-side text filter on `productionDate` field.
- **Orders table**: Shows order number, nickname, customer, quantity, total, production date, due date, status badge. Checkbox selection (individual or select-all).
- **Action buttons** (contextual — show count of eligible orders):
  - **Print Workorders** — posts selected `workorderUrl` values to `/api/print-combined`, opens result in popup
  - **Print All Workorders** — same but for all filtered orders
  - **Print Packing Slips** — posts selected `packingSlipUrl` values to `/api/print-packing-slips`, opens launcher popup
  - **Print Box Labels** — posts selected `invoiceUrl + "/box_labels"` to `/api/print-box-labels`, opens launcher popup
  - **Change Status** — dropdown + apply button to bulk-update selected orders' statuses

### Auto Print Mode (`/auto-print`)
- Configuration form: enable/disable, schedule interval, source statuses, doc type toggles, printer selection per doc type, copy counts, dry-run mode, error status
- Category → status mapping table (add/remove rows)
- "Run Now" button with dry-run toggle
- Job history table (last 50 runs) with status badges and error messages

---

## Known Constraints

- **Packing slip / box label HTML pages are session-gated**: Printavo returns `X-Frame-Options: SAMEORIGIN` and requires browser cookie auth. API token headers, query-param token auth, and iframes all fail. The app opens these URLs in the user's existing browser session instead.
- **Workorder URLs are public**: They use a random hash token and are designed to share with customers — no auth needed.
- **Printavo API rate limit**: 10 req/5 sec. The app staggers paginated requests by 600ms between pages and staggers individual workorder fetches by 200ms.
- **Max 50 orders per print operation**.
- **PrintNode requirement**: Auto-print PDF delivery requires a PrintNode account and API key. Manual print (workorders) does not use PrintNode — it sends HTML to the browser for the user to Ctrl+P.
