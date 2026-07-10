---
name: SanMar pricing semantics (verified)
description: What SanMar's authenticated getProductInfoByStyleColorSize price fields actually mean — piecePrice is net cost, pieceSalePrice is a dated-sale promo.
---

# SanMar pricing — verified against the live authenticated API

For this account's `getProductInfoByStyleColorSize` (SanMarProductInfoServicePort),
the `<productPriceInfo>` fields mean:

- **`piecePrice` = the regular account NET piece cost.** This is THE cost for POs.
  It is NOT MSRP. (MAP/retail lives in a separate `mapPrice` tag.)
- **`pieceSalePrice` = a promotional price present ONLY during a dated sale.**
  It is `null` when the item is not on sale.
- `casePrice`/`dozenPrice` are a net tier ladder below `piecePrice` (cheaper per
  piece when buying a full case/dozen).

**Rule:** `cost = piecePrice`. Treat `pieceSalePrice` as a genuine sale override
only when `pieceSalePrice > 0 && pieceSalePrice < piecePrice && saleEndDate present`
(mirrors the S&S branch). Effective unit cost consumed by the UI = `salePrice ?? cost`.

**Why this matters:** the codebase (and older memory) claimed the opposite —
`pieceSalePrice = net cost, piecePrice = MSRP`, with an explicit "do not change".
That was false. It happened to work for staples that SanMar keeps on rolling sales
(their `pieceSalePrice` was populated), but any not-on-sale style got `cost = null`,
which surfaced as "no vendor price" and blocked PO save. It would also have broken
every on-sale style the moment its sale expired.

**Evidence (July 2026 live probes):**
- PC61 (on sale 7/6–7/12): `piecePrice=4.45`, `pieceSalePrice=3.02`, `saleEndDate=2026-07-12`
  → cost 4.45, salePrice 3.02, effective 3.02.
- CSV102 (not on sale): `piecePrice=10.22/11.22/12.22` by combined size,
  `pieceSalePrice=null`, no sale dates → cost 10.22/11.22/12.22, effective same.

**How to apply:** any SanMar cost mapping (Hub `vendorLookup.ts` sanMarToColors,
and legacy PO Builder if ever revived) must use `piecePrice` as cost. Do not
reintroduce the "piecePrice = MSRP" fallback-to-null behavior.

# SanMar combined-size labels

SanMar abbreviates combined sizes: `2XL/3XL` is returned as **`2/3X`** and
`4XL/5XL` as **`4/5X`** — the size-class letters appear only on the LAST token and
distribute across bare-number prefixes. `S/M` and `L/XL` carry their own suffixes.
When matching to a Printavo column by first component, a bare-numeric first token
must borrow the trailing alpha suffix from the last token (`2/3X` → `2X` → 2XL),
else it won't match the `2XL`/`4XL` columns. Still first-component-only to avoid
two Printavo columns claiming one vendor unit (double-order).
