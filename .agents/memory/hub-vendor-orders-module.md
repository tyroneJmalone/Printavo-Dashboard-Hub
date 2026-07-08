---
name: Hub Vendor Orders module — PO cart design decisions
description: Durable decisions from the Hub's purchasing module (P2 cart/pricing/po_files) — snapshot schema rules, cost semantics, dedup/size-matching rules, and P3/P4 landmines
---

# po_files design (P2, approved)
- POs are **snapshots**: structured jsonb line_items only, Printavo ids stored as TEXT, **no FKs to pv_*** (sync deletes+reinserts those tables).
  **Why:** FKs would cascade-break POs every 5-minute sync.
- **No stored HTML** — printable PO rendered on demand from the row. Keeps edits authoritative, but see P3 landmine below.
- `po_number` has a **unique index**; API returns 409 "already in use". Multi-vendor cart saves one PO per vendor with `-SM/-SS/-M` suffixes, and the cart drops each vendor group *as it saves* so a retry after a partial failure can never duplicate.
  **Why:** sequential group saves + retry previously could silently re-insert already-saved groups.

# Cost semantics (do not regress)
- SanMar: `pieceSalePrice` IS the account net cost; `piecePrice` is MSRP. **Never fall back to MSRP when net cost is null** — return null and let the UI show "No vendor price" + manual cost.
  **Why:** the fallback silently inflated PO totals with retail pricing.
- S&S: sale price is genuine only if `salePrice > 0 && salePrice < piecePrice && saleExpiration` present.

# Size matching
- Printavo and vendor size labels disagree constantly (XXL vs 2XL, OS/ONE SIZE/ADJ vs OSFA). Cart matching canonicalizes both sides through an alias map before comparing. Extend the map, don't add ad-hoc comparisons.
- Line items with no sizes get a single OSFA row with qty = items.

# P3/P4 landmines (recorded by architect review, not yet actioned)
- **P3 auth:** api-server has no auth + open CORS. `productionFileCreate` needs a public URL for the PO HTML — before any public exposure, add auth or signed/tokenized HTML URLs, or vendor-lookup becomes an unauthenticated proxy burning SanMar/S&S quota.
- **P3 drift:** HTML renders live from the row; consider freezing PO edits once `pushed_to_printavo_at` is set, or Printavo's referenced document silently changes.
- **P4:** warehouse quantities from lookup are dropped at save (no warehouse field in the size entry) — plan to re-lookup at submit time (inventory must be current anyway). Sale unitCost is saved without saleEndsAt; an expired sale can mismatch the vendor invoice.
