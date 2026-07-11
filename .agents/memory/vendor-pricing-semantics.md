---
name: Vendor pricing field semantics (SanMar / S&S)
description: Which price fields are the shop's real dealer cost in SanMar SOAP and S&S REST responses, SanMar combined-size labels, and vendor search quirks — this has been gotten wrong twice.
---

# SanMar (SOAP getProductInfoByStyleColorSize → productPriceInfo)

**Rule:** `casePrice` is the shop's regular dealer NET cost — the baseline. `piecePrice` is the HIGHER broken-case tier, never the baseline. Sale = `caseSalePrice`, genuine only when `>0 && < regular && saleEndDate present`. Effective unit cost consumed by UI = `salePrice ?? cost`. Map costs casePrice-first: `casePrice ?? piecePrice`.

**Why (two prior wrong beliefs, in order):**
1. First belief: "pieceSalePrice = net cost, piecePrice = MSRP" — false; left every not-on-sale style with cost null and blocked PO save. Only appeared to work because staples sit on rolling sales.
2. Second belief: "piecePrice = the account net cost" — also wrong. Tyler (shop owner) confirmed the real PC54 cost is $3.00 = casePrice; piecePrice was $4.00. The original Breezy app likewise used the Pricing service's casePrice as regular. (MSRP/retail actually lives in `mapPrice`.)

Live evidence (July 2026): PC54 Jet Black S–XL: piece 4.00 / pieceSale 2.44 / case 3.00 / caseSale 2.44, saleEnd 2026-07-12.

**How to apply:** Anywhere SanMar costs feed quotes/POs (Hub vendorLookup sanMarToColors and any revival of legacy PO Builder). Caveat to surface to the user: broken-case (below case-quantity) orders may invoice at the higher piecePrice, so estimates can run slightly low there. No price is ever transmitted to vendors in PO submits — internal estimates only.

# SanMar combined-size labels

SanMar abbreviates combined sizes: `2XL/3XL` comes back as **`2/3X`**, `4XL/5XL` as **`4/5X`** — size-class letters appear only on the LAST token and distribute across bare-number prefixes (`S/M`, `L/XL` carry their own). When matching to a Printavo column by first component, a bare-numeric first token must borrow the trailing alpha suffix from the last token (`2/3X` → `2X` → 2XL), else it won't match `2XL`/`4XL` columns. Still first-component-only so two Printavo columns never claim one vendor unit (double-order risk).

# S&S Activewear (REST /products)

`piecePrice` = regular dealer cost. `salePrice` genuine only if >0, < piecePrice, and `saleExpiration` present. `customerPrice` mirrors salePrice during sales — never a baseline.

# SanMar plus-size color-bucket split

SanMar sometimes returns 4XL/5XL rows under a SEPARATE, abbreviated `catalogColor` ("AntqChryRd") from the S–3XL bucket ("Antqu Chry Red"), even though both share the same display `<color>` tag ("Antique Cherry Red"). Verified live on Gildan 5000.

**Why it matters:** the abbreviated bucket sorts alphabetically first and is plus-size-only, so any "first color" / "cheapest size" default can surface a plus-size price as the base garment cost (Tyler's rule: base price ALWAYS from XS–XL; plus-size upcharges are adjusted manually).

**How to apply:** do NOT merge these buckets server-side — inventory checks and PO submits require the exact per-bucket catalogColor string per size (merging risks wrong-color orders). Handle it at display time: prefer XS–XL-priced sizes/colors when picking a default price.

# Vendor search quirks

- S&S `/styles/?search=` relevance can put the WRONG brand first when brands share a style number (bare "5000" → Bayside, not Gildan). Brand words typed in the query must outweigh S&S's own ordering.
- SanMar SOAP has no keyword search — only exact style lookup. Multi-word queries need candidate fallback: digit-bearing tokens as style numbers, then brand-initials+digits combos ("sport tek 350" → try "350", then "ST350" — many vendor codes are brand initials + number). Each SOAP call is slow (15s+) and the edge proxy kills requests around ~48s, so cap fallback attempts; wrong candidates fail fast with "Invalid style".
- Exact-vs-closest labeling: match remaining query words against brand+title with WHOLE-WORD comparison only; substring matching lets "co" match "cotton" and suppresses the double-check warning.
