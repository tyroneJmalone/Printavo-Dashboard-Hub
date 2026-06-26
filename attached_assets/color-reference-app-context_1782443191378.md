# Color Reference Database — App Context for Dashboard Integration

## Purpose

This is a standalone internal tool used by a print/embroidery shop to manage a master color reference database. It maps a single Pantone C color to its equivalent thread numbers, screen print inks, and DTF colors — giving production staff a single source of truth for color matching across all decoration methods.

It is **not currently connected to Printavo**, but is intended to be part of a combined dashboard that shares the same Printavo account.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Wouter (routing) |
| UI Components | Shadcn UI (Radix UI + Tailwind CSS) |
| State / Data Fetching | TanStack Query v5 |
| Backend | Node.js + Express, TypeScript (ESM) |
| Database | PostgreSQL (Neon serverless) via Drizzle ORM |
| Color Science | Server-side Delta E CIE2000 algorithm (custom implementation) + chroma-js (client) |

Runs on a single port — Vite dev server proxies to Express in development; Express serves static files in production. All API routes are under `/api`.

---

## Database Schema — `colors` Table

Each row represents **one color combination** — a Pantone matched to specific thread numbers and inks. The same Pantone name can appear on multiple rows (e.g., matched to different thread colors).

```
id                        UUID (primary key)
hexCode                   e.g. "#F6EB61"
rgb                       e.g. "246, 235, 97"
cmyk                      e.g. "0, 4, 61, 4"
pantoneC                  e.g. "100 C"
pantoneShelf              e.g. "A3" — shelf location in physical inventory
madeiraPolyneonName       e.g. "Lemonade"
madeiraPolyneonNumber     e.g. "1735"
polyneonInStock           boolean — whether this thread is in inventory
madeiraClassicRayonName   e.g. "Lemon"
madeiraClassicRayonNumber e.g. "1023"
rayonInStock              boolean
wilflexRfu                e.g. "Yellow 012" — Wilflex RFU screen print ink name
wilflexInStock            boolean
houseInk                  e.g. "Custom Yellow" — house mixed ink name
ultraColorDtf             e.g. "DTF Yellow" — UltraColor DTF color name
```

**Total records: ~6,199** (imported from a master Excel spreadsheet).

### Stock Propagation Behavior
When a record is edited to mark something as in-stock or assign a shelf location, those values **automatically propagate to every other row** sharing the exact same Pantone name, Polyneon number, Rayon number, or Wilflex name. You mark stock once; it updates everywhere that item appears.

---

## REST API Endpoints

All under `/api`. No authentication currently.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/colors` | All 6,199 records |
| GET | `/api/colors/:id` | Single record by UUID |
| GET | `/api/colors/search?q=` | Case-insensitive partial match across all text fields |
| POST | `/api/colors` | Create a new color record |
| PATCH | `/api/colors/:id` | Update a record (triggers stock propagation) |
| DELETE | `/api/colors/:id` | Delete a record |
| POST | `/api/colors/bulk` | Bulk insert (used by import script) |
| GET | `/api/colors/match?r=&g=&b=&top_n=5` | Delta E CIE2000 color match — returns closest matches grouped by color system |

### Color Match API Response Shape (`/api/colors/match`)

```json
{
  "pantone": [
    { "id": "uuid", "hex": "#F6EB61", "pantone": "100 C", "distance": 1.42 }
  ],
  "polyneon": [
    { "id": "uuid", "hex": "#...", "pantone": "...", "name": "Lemonade", "number": "1735", "distance": 2.1 }
  ],
  "rayon": [ ... ],
  "ultraColorDtf": [ ... ],
  "wilflex": [ ... ],
  "houseInk": [ ... ]
}
```

Each entry includes the record `id` for direct CRUD operations. `distance` is the Delta E CIE2000 value — lower is closer. Interpretation: <2 Near Identical, 2–5 Very Close, 5–10 Noticeable, 10–15 Significant, >15 Poor.

---

## Color Systems Covered

| System | Type | Use Case |
|---|---|---|
| Pantone C | Spot color standard | Universal color reference, Pantone fan deck |
| Madeira Polyneon | Polyester embroidery thread | Machine embroidery on poly/performance fabric |
| Madeira Classic Rayon | Rayon embroidery thread | Machine embroidery on cotton/standard fabric |
| Wilflex RFU | Screen print ink (Ready For Use) | Plastisol screen printing |
| House Ink | Custom mixed screen print ink | Shop-specific ink formulas |
| UltraColor DTF | Direct-to-film transfer ink | DTF heat transfer printing |

---

## Key Frontend Features

- **Spreadsheet-style data table** — sortable columns, sticky header, hover-reveal Edit / Duplicate / Delete buttons per row
- **In-stock visual indicators** — green cell background + checkmark icon on Pantone C + Shelf, Poly #, Rayon #, and Wilflex columns when marked in stock
- **Find Color Match panel** — always visible, tabbed search by:
  - Pantone name (exact match, "C" suffix flexible)
  - HEX code (with or without `#`)
  - RGB values
  - CMYK values
  - Polyneon name or number
  - Classic Rayon name or number
  - Wilflex RFU name
  - House Ink name
  - UltraColor DTF name
- For HEX/RGB/CMYK searches: calls Delta E match API, displays top 5 closest per color system with ΔE scores
- For text searches: shows exact matches, then also shows Delta E cross-system suggestions based on the first matched color's hex
- Edit form dialog with color swatch preview, shelf location field, and in-stock checkboxes
- CSV export of current filtered view
- Dark/light mode toggle
- Database can be bulk-replaced by running `scripts/import-excel.ts` with a new spreadsheet

---

## Printavo Integration Opportunities

This app currently operates independently, but the color data is directly relevant to Printavo order workflows. Potential integration points:

1. **Order line item decoration lookup** — When a Printavo order specifies a color (Pantone, thread, or ink), this API could resolve which physical inventory items are available for that order
2. **Color specification on quotes/orders** — A dashboard could embed a color picker that queries `/api/colors/match` and attaches the selected color system values to a Printavo line item or custom field
3. **In-stock filtering** — Surface only in-stock threads/inks when assigning colors to a Printavo order, avoiding production delays
4. **Pantone to production method mapping** — Given a customer-specified Pantone, instantly show which embroidery threads and inks are available in-stock for that color across all decoration methods

---

## Data Import / Maintenance

- **Initial load**: 6,199 rows imported from a vendor-provided Excel file using `scripts/import-excel.ts` (replaces entire table)
- **Ongoing edits**: Done via the frontend UI (individual add/edit/delete/duplicate)
- **Stock tracking**: Managed via edit form checkboxes — propagates automatically across all matching rows
- **LAB color cache**: Server maintains an in-memory cache of pre-computed LAB values per color ID for fast Delta E calculations; cache is invalidated on any write operation

---

## Environment / Deployment

- **Runtime**: Node.js on Replit
- **Database**: PostgreSQL via `DATABASE_URL` environment secret (Neon serverless)
- **Session**: `SESSION_SECRET` environment secret (available, auth not currently implemented)
- **Schema management**: Drizzle Kit (`npm run db:push` applies schema changes)
- **Build**: `npm run build` (Vite for client, esbuild for server) → `npm start` for production
