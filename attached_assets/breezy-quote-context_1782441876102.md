# Breezy Quote — App Context for Integration Planning

## What It Does

Breezy Quote is a **price calculator for garment decoration businesses** (screen printing, embroidery, DTG, etc.). It helps shops quickly generate accurate per-piece pricing quotes by combining garment cost, markup, and decoration costs across up to four print locations.

**Core pricing formula:**
```
(Garment Cost × Markup Multiplier) + Sum of All Decoration Costs = Unit Price
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite (TypeScript), Tailwind CSS, shadcn/ui |
| Backend API | Node.js + Express (TypeScript), deployed as autoscale |
| Database | PostgreSQL via Drizzle ORM |
| Monorepo | pnpm workspace |
| Deployment | Replit autoscale (Cloud Run) |

**Deployed at:** `*.replit.app` — two separate services:
- **Frontend** — static build served from CDN
- **API Server** — Express app at the `/api/*` path prefix

---

## Key Features

### 1. Decoration Price Matrices
The heart of the app. A **matrix** is a named pricing table that defines decoration costs by quantity tier and a second axis (e.g. number of colors, stitch count, size).

- **Structure:** 2D — one row per column label (e.g. "1 Color", "2 Colors"), each with quantity-based price breaks
- **Price break logic:** highest qualifying tier wins (e.g. qty 50 gets the 48+ rate)
- **Storage:** Server-side in PostgreSQL — all teammates share the same matrices in real time
- **Management UI:** Create, edit, delete, duplicate matrices; bulk CSV import; one-click "Load Starter Matrices" for new installs

**Matrix data shape (JSON stored in DB):**
```json
{
  "name": "Screen Print",
  "xAxisLabel": "Colors",
  "xValues": [
    {
      "label": "1 Color",
      "breaks": [
        { "qty": 12,  "decorationCost": 4.50 },
        { "qty": 24,  "decorationCost": 3.50 },
        { "qty": 48,  "decorationCost": 2.75 }
      ]
    },
    {
      "label": "2 Colors",
      "breaks": [...]
    }
  ]
}
```

### 2. Multi-Location Support
Up to **4 decoration locations** per quote. Each location independently selects its own matrix and column (e.g. Front = Screen Print / 2 Colors, Left Chest = Embroidery / 8k stitches). All location costs are summed per quantity tier.

### 3. Markup Presets
Multiplier from 1.0× to 2.0× in 0.05 steps (21 presets). Users can also type a custom value. Default is 1.75×.

### 4. Vendor Garment Lookup (Real Dealer Pricing)
Integrates with two wholesale vendors via live API calls — no manual price entry needed.

**S&S Activewear:**
- REST API at `api.ssactivewear.com/v2`
- Auth: Basic (`SS_ACCOUNT_NUMBER:SS_API_KEY`)
- Key fields used: `piecePrice` (regular dealer price), `salePrice` (promotional price), `saleExpiration` (sale end date)
- Lookup: search by style number → fetch all SKUs → deduplicate by color, take first size

**SanMar:**
- SOAP/XML Web Services (`ws.sanmar.com:8080`)
- Two services used:
  - `SanMarProductInfoServicePort` — product info, catalog prices, images
  - `SanMarPricingServicePort` — real dealer net prices (`casePrice` = regular, `salePrice` = promotional)
- Auth: account number + username + password in each SOAP request
- Key logic: select the color entry with lowest catalog `piecePrice` to identify base-size inventory key for dealer pricing call
- `SANMAR_ACCOUNT_NUMBER=164656` stored as a shared env var

**Sale Price Toggle:** When either vendor returns a sale price lower than the regular price, an amber banner appears in the lookup dialog with a Regular / Sale Price toggle — user chooses which price feeds into the calculator.

### 5. Output & Sharing
- **Results table:** Quantity | Decoration Cost | Unit Price | Total Order Value — one row per price break tier
- **Copy to clipboard:** All tiers, or filtered by preset quantity ranges (e.g. 12–48, 144–288)
- **Save as PNG:** Captures the full calculator view (inputs + results) at 2× resolution and downloads as `breezy-{matrix-name}-{date}.png`

### 6. Dark Mode
Toggle in nav bar; persisted to `localStorage` under key `breezy-theme`.

---

## API Endpoints

All routes are prefixed with `/api`.

### Matrices (shared pricing tables)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/matrices` | List all matrices |
| `POST` | `/api/matrices` | Create or upsert a matrix |
| `PUT` | `/api/matrices/:id` | Update a matrix by ID |
| `DELETE` | `/api/matrices/:id` | Delete a matrix by ID |

### Vendor Lookup
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/vendor/ss/product/:style` | S&S product lookup by style number |
| `GET` | `/api/vendor/sanmar/product/:style` | SanMar product lookup by style number |

**Vendor response shape (both vendors):**
```json
{
  "vendor": "ss" | "sanmar",
  "style": "5590",
  "brand": "Hanes",
  "title": "Men's Authentic Pocket T-Shirt",
  "styleImage": "https://...",
  "colors": [
    {
      "colorName": "Black",
      "colorCode": "50",
      "price": 6.01,
      "salePrice": 5.75,
      "saleEndDate": "2026-04-14T00:00:00",
      "swatchImage": "https://...",
      "frontImage": "https://..."
    }
  ]
}
```

### Health
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/healthz` | Health check (used by deployment startup probe) |

---

## Database Schema

```sql
CREATE TABLE matrices (
  id         TEXT PRIMARY KEY,       -- UUID
  name       TEXT NOT NULL,
  data       JSONB NOT NULL,         -- full matrix object (name, xAxisLabel, xValues)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

No user accounts, no authentication — single-tenant, team-shared.

---

## Environment Variables / Secrets

| Variable | Where set | Purpose |
|---|---|---|
| `DATABASE_URL` | Replit DB integration | PostgreSQL connection string |
| `SS_ACCOUNT_NUMBER` | Replit secret | S&S Activewear account number |
| `SS_API_KEY` | Replit secret | S&S Activewear API key |
| `SANMAR_USERNAME` | Replit secret | SanMar SOAP username |
| `SANMAR_PASSWORD` | Replit secret | SanMar SOAP password |
| `SANMAR_ACCOUNT_NUMBER` | Replit userenv (shared) | `164656` — SanMar dealer account |
| `PORT` | Replit runtime | Port for Express server (set to `8080` in production) |

---

## What This App Does NOT Do

- No Printavo integration (yet)
- No order creation or job management
- No customer/contact records
- No authentication or user accounts
- No garment inventory management
- No shipping or tax calculation
- No PDF quote generation (PNG export only)

---

## Integration Opportunity Notes

Since this app already has:
- **Live S&S and SanMar dealer pricing** (real costs, including sale detection)
- **Shared decoration pricing matrices** (stored server-side, team-visible)
- **The full unit price formula** already working

A combined dashboard could pull the garment cost and unit price calculated here directly into a Printavo quote/order flow. The `/api/vendor/*` endpoints and `/api/matrices` endpoints are straightforward REST and could be called from a shared backend or proxied from a dashboard app.

The matrices API accepts upserts (`POST` with an `id` field), so a dashboard could programmatically sync decoration pricing from Printavo's existing pricing tables if needed.
