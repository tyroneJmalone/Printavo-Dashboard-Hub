# Mint Printworks Reorder Portal — Agent Handoff Doc

> **Purpose:** Comprehensive reference for another agent integrating with or extending this codebase (e.g. building a dashboard, adding analytics, or extending API routes).

---

## Project Overview

A customer-facing **reorder portal** for a print shop. Customers look up their order history by email or company name, view mockup images, and submit reorder requests that email the sales team.

- **No database** — all data fetched live from Printavo's GraphQL API v2
- **Stack:** React + Vite (frontend), Express.js (backend), TanStack Query, Shadcn UI, Tailwind CSS
- **Email:** Resend (via Replit connector)
- **Secrets required:** `PRINTAVO_API_EMAIL`, `PRINTAVO_API_TOKEN`, `SESSION_SECRET`

---

## File Map

```
shared/schema.ts          — All TypeScript types, Zod schemas, SIZE_LABEL_MAP
server/printavo.ts        — Printavo GraphQL API client (getStatuses, getOrdersBySearch)
server/email.ts           — Resend email integration (sendReorderEmail)
server/routes.ts          — Express API route registration
server/index.ts           — Entry point, server setup
client/src/pages/home.tsx — Entire frontend: search form, order cards, reorder modal
client/src/App.tsx        — React router root
```

---

## Data Types (from `shared/schema.ts`)

### `PrintavoOrder`
```ts
{
  id: string                  // Printavo internal ID
  visualId?: string           // Human-readable order number (e.g. "1042")
  orderNickname?: string      // "nickname" field in Printavo API
  customerName?: string
  customerEmail?: string
  customerCompany?: string
  status?: string             // Status name (e.g. "In Production")
  statusColor?: string        // Hex color string from Printavo
  total?: string              // Formatted currency string
  dueDate?: string            // ISO date (dueAt field)
  customerDueDate?: string    // ISO date (customerDueAt field)
  createdAt?: string
  publicUrl?: string          // Public invoice link (opens in new tab)
  mockupUrl?: string          // Order-level mockup image URL
  lineItemCount?: number      // Count of deduplicated line items
  orderTotalQty?: number      // Sum of all line item quantities
  lineItems?: LineItem[]
}
```

### `LineItem`
```ts
{
  id: string
  description?: string        // Line item description
  color?: string              // Garment color
  itemNumber?: string         // Supplier item/style number
  brand?: string              // Garment brand
  productName?: string        // product.description from Printavo
  category?: string           // category.name
  totalQty?: number           // Total pieces for this line item
  sizes?: LineItemSize[]      // Array of { size: string, count: number | null }
  mockupUrl?: string          // Line-item-level mockup (preferred over order-level)
}
```

### `LineItemSize`
```ts
{ size: string; count: number | null }
// `size` is a Printavo enum key like "size_m", "size_xl", "size_2xl"
// Use SIZE_LABEL_MAP to convert to human labels: { size_m: "M", size_xl: "XL", ... }
```

### `SIZE_LABEL_MAP`
Maps Printavo size enum keys → display labels. Covers:
- Adult: `size_xs` through `size_6xl`, `size_other`
- Youth: `size_yxs` through `size_yxl`
- Infant: `size_6m`, `size_12m`, `size_18m`, `size_24m`, `size_2t`–`size_5t`

### `ReorderRequest` (POST body for `/api/reorder`)
```ts
{
  orderId: string
  visualId?: string
  orderNickname?: string
  customerName?: string
  customerEmail: string       // required
  notes?: string
  lineItemOrders?: LineItemReorder[]
}
```

### `LineItemReorder`
```ts
{
  lineItemId: string
  productName?: string
  color?: string
  itemNumber?: string
  sizes: { size: string; qty: number }[]  // size is already human label here
}
```

---

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/statuses` | All Printavo order statuses `[{ id, name, color }]` |
| `GET` | `/api/orders?q={value}&type={email\|company}` | Orders for customer. Returns `PrintavoOrder[]` |
| `POST` | `/api/reorder` | Send reorder email. Body: `ReorderRequest`. Returns `{ success: true }` |

### `/api/orders` Details
- `type=email` — exact email match (case-insensitive)
- `type=company` — substring match on company name (case-insensitive)
- Fetches last **15 invoices** from Printavo matching the search term, then filters client-side
- Response is an array of `PrintavoOrder` objects with `lineItems` already populated and deduplicated

---

## Printavo GraphQL API Notes

- **Endpoint:** `https://www.printavo.com/api/v2`
- **Auth headers:** `email` + `token` (not Bearer, just raw header names)
- **Subdomain:** `mintprintworks`
- **Query complexity limit:** 25,000

### Correct field names (common gotchas)
| Wrong | Correct |
|-------|---------|
| `orders` | `invoices` |
| `orderNickname` | `nickname` |
| `orderstatus` | `status` |
| `sortDirection: DESC` | `sortDescending: true` |
| `imageUrl` on Mockup | `fullImageUrl` |

### Current query limits (to stay under complexity cap)
```graphql
invoices(first: 15, sortOn: VISUAL_ID, sortDescending: true, query: $searchQuery)
  lineItemGroups(first: 5)
    lineItems(first: 8)
    imprints(first: 1)
      mockups(first: 1)
```

### Mockup URL resolution (priority order)
1. `lineItem.mockups.nodes[0].fullImageUrl` — line item level (preferred)
2. `lineItemGroup.imprints.nodes[0].mockups.nodes[0].fullImageUrl` — imprint level
3. Falls back to order-level mockup in the UI

---

## Line Item Deduplication

Done in `server/printavo.ts` before returning the response. Dedup key:
```
itemNumber.toLowerCase() + "|||" + color.toLowerCase() + "|||" + (description || productName).toLowerCase()
```
- Items with an empty key (all three fields blank) are **not** deduplicated
- When merging duplicates: `totalQty` is summed, `sizes[].count` values are summed per size key, first non-null `mockupUrl` wins

---

## Frontend Architecture (`client/src/pages/home.tsx`)

Single page app with two view states managed by `searchQuery` state:

### View 1 — Search / Landing
- Radio: search by Email or Company Name
- Email validated via Zod (`customerLookupSchema`)
- On submit: sets `searchQuery` state, triggers TanStack Query fetches for orders + statuses

### View 2 — Order Dashboard
- **StatusFilterBar** — togglable status pills; all statuses on by default; client-side filter
- **OrderCard** per order — shows mockup thumbnail, nickname, status badge, visualId, total, due date, product count, total pcs, Invoice Link button, Reorder Now button
- **ReorderModal** (Dialog) — triggered by Reorder Now:
  - Order summary (visualId, name, customer, total qty)
  - Per-product `LineItemSizeEntry` accordion items (collapsed by default):
    - Thumbnail with hover-to-enlarge (896×896px, capped at 90vw/vh)
    - Size grid with `<Input type="number">` cells (blank/placeholder "0")
    - Previous qty shown as "was X" hint below each input
  - Notes textarea (optional)
  - Submit → POST `/api/reorder` → toast confirmation

### Key state variables in `Home()`
```ts
searchQuery: { value: string; type: "email" | "company" } | null
activeStatusIds: Set<string>   // which status filters are active
reorderOrder: PrintavoOrder | null  // order in reorder modal
statusesInitialized: boolean   // prevent re-resetting filters on re-render
```

---

## Email Notifications

- **Provider:** Resend via Replit connector (fetches API key at runtime from connector service)
- **Recipient:** `info@mintprintworks.com`
- **Subject:** `Reorder Request: {orderName} from {customerName}`
- **Content:** HTML email with order summary table + per-product breakdown with size/qty rows and subtotals + grand total pcs

---

## Environment / Secrets

| Secret | Used in |
|--------|---------|
| `PRINTAVO_API_EMAIL` | `server/printavo.ts` — Printavo auth header |
| `PRINTAVO_API_TOKEN` | `server/printavo.ts` — Printavo auth header |
| `SESSION_SECRET` | `server/index.ts` — Express session |

Resend API key is fetched at runtime from the Replit connector service (not a static env var).

---

## Potential Extension Points for a Dashboard

If you are building an **admin/internal dashboard** on top of this codebase, here are the most relevant integration points:

### New API routes to add in `server/routes.ts`
```ts
// Example: all recent orders (not filtered to a customer)
GET /api/admin/orders?status={statusId}&page={n}

// Example: order detail by visualId
GET /api/admin/orders/:visualId
```

### Printavo queries to reference
The `graphqlQuery()` helper in `server/printavo.ts` is reusable — just add new exported functions alongside `getOrdersBySearch` and `getStatuses`.

### Frontend routing
Uses `wouter`. Add new pages in `client/src/pages/` and register routes in `client/src/App.tsx`.

### Data already available per order
Every `PrintavoOrder` object includes `lineItems[]` with full size breakdowns, mockup URLs, brand/color/itemNumber — sufficient for product-level analytics without additional API calls.

### Printavo API: additional fields available (not currently fetched)
- `paymentStatus`, `amountPaid`, `amountOutstanding` on invoice
- `customer.id`, `customer.phone` on contact
- `shippingAddress` on invoice
- Multiple mockups per imprint (currently only `first: 1`)
- More line item groups (currently only `first: 5`)

---

## Running the App

```bash
npm run dev
```

Starts Express + Vite dev server together on the same port (configured via `server/vite.ts`). No separate start commands needed. The workflow "Start application" handles this in Replit.

---

*Last updated: 2026-06-26*
