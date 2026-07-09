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

# PO editing (post-P2 change requests, approved pattern)
- PO Log edit replaces line items **wholesale** via PATCH; server always recomputes totals from the lines — client never sends totals.
- A PO can never be saved with a 0-piece line or an empty line list; deleting the whole PO is a separate explicit action.
- Add-replacement flow searches the **PO's own vendor**; manual entry is always available as fallback (vendor style not in catalog).

# E2E testing rule for this module
- The e2e subagent edits REAL PO data when testing PO Log edit flows. Always snapshot the PO list (curl) before running such tests and restore afterwards — line-item snapshots can be reconstructed from pv_line_items sizes + a fresh vendor lookup (SKUs/costs), but only if you know which line was touched.
  **Why:** a test once removed a real line from Tyler's PO; restoration required cross-referencing DB + S&S.

# PO lock model (P2.6, approved)
- Two lock tiers: vendor submission (`submitted_to_vendor_at`) is a **permanent** lock — no unlock path by design; Printavo push (`pushed_to_printavo_at`) locks but is manually unlockable (`manually_unlocked` flag).
  **Why:** Tyler's rule — once a vendor has the order, the PO must match what was sent forever; Printavo pushes are internal and correctable.
- `lockState()` in the api-server po_files lib is the **single source of truth**; every mutation (patch/append/delete/unlock) runs in a transaction with SELECT FOR UPDATE and re-checks it server-side. UI hiding buttons is cosmetic only.
- **P3 obligation:** re-pushing a PO to Printavo must reset `manually_unlocked=false` (re-lock). Documented in schema + lib comments — do not forget when building write-backs.
- Cart append-to-existing: destination selects list only *unlocked* POs with matching vendor_name; cart Notes apply only to NEW POs (silently ignored on append).

# SanMar live inventory (verified working July 2026)
- `getInventoryQtyForStyleColorSize` works and is fast (~200-600ms) BUT requires the EXACT catalogColor from ProductInfo ("Jet Black", not "Black") or it errors "Invalid product specified". The legacy app's "flaky inventory" reputation was almost certainly this mismatch — do not design around it being broken.
  **Why:** probed live with real creds after Tyler pushed back on the flakiness assumption; PC54 failed with "Black", succeeded with "Jet Black".

# Warehouse auto-pick (P3b, approved behavior)
- Auto-pick hierarchy per vendor+order group in the cart: one warehouse covering the whole order → per style+color subgroup → per-line best; ties broken by deepest total stock. A capped "3000+" counts as covering (a single size never needs >3000 for this shop).
- **Deep-stock SanMar styles tie at 3000 everywhere → auto-pick defaults to warehouse #1 (Seattle).** This is the NORMAL case for popular styles, not an edge case. If Tyler wants proximity, add a preferred-warehouse ordering constant — flagged to him at P3b delivery.
  **Why:** SanMar caps reported qty at 3000/warehouse, so total-stock tie-breaking degenerates to SANMAR_WAREHOUSES array order.
- S&S per-warehouse quantities come free from the cached vendorLookup feed (no extra API call); warehouse "name" is just the abbr code (e.g. "CN") — S&S publishes no long names in that feed.
- Stale-response guard in the cart drawer compares catalogColor only; if two styles share an identical color name a stale response could slip through. Add a style/request token if this code is touched again (architect: low probability, deferred).

# Workspace build quirk
- api-server/hub typecheck reads lib/db's emitted `dist/*.d.ts` (composite TS project refs) — after ANY lib/db schema change run `./node_modules/.bin/tsc -b lib/db` or typecheck fails with "property does not exist" on new columns.
  **Why:** lib/db has no build script; drizzle push updates the DB but not the declaration output.

# PO HTML public token route (P3a, July 2026)
- `/api/purchasing/po-html/:token` is the ONLY unauthenticated endpoint by design (Printavo fetches PO HTML async after productionFileCreate). Token = 256-bit hex, unique-indexed, never in DTOs/OpenAPI, NON-expiring; every P3c push must regenerate it via newHtmlToken() and hand Printavo publicPoHtmlUrl().
- Replace action in PoEditor inherits printavoLineItemId/orderId/visualId but NOT quantities — P3c lineItemUpdate must push the new sizes/qty to Printavo rather than assume they match the invoice line.

# P3/P4 landmines (recorded by architect review, not yet actioned)
- Closest-match lookups save the *queried* style as styleNumber, not the vendor's resolved styleName — persist styleName (or rely on SKUs) before P4 vendor submission.
- PO edit/delete is allowed regardless of pushedToPrintavoAt — add a guard/warning when P3 write-backs land.
- **P3 auth:** api-server has no auth + open CORS. `productionFileCreate` needs a public URL for the PO HTML — before any public exposure, add auth or signed/tokenized HTML URLs, or vendor-lookup becomes an unauthenticated proxy burning SanMar/S&S quota.
- **P3 drift:** HTML renders live from the row; consider freezing PO edits once `pushed_to_printavo_at` is set, or Printavo's referenced document silently changes.
- **P4:** warehouse quantities from lookup are dropped at save (no warehouse field in the size entry) — plan to re-lookup at submit time (inventory must be current anyway). Sale unitCost is saved without saleEndsAt; an expired sale can mismatch the vendor invoice.
