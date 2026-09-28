---
name: Vendor pricing field semantics (SanMar / S&S)
description: Which price fields are the shop's real dealer cost in SanMar SOAP and S&S REST responses, SanMar combined-size labels, and vendor search quirks — this has been gotten wrong twice.
---

# SanMar (SOAP getProductInfoByStyleColorSize → productPriceInfo)

**Rule:** `casePrice` is the shop's regular dealer NET cost — the baseline. `piecePrice` is the HIGHER broken-case tier, never the baseline. Sale = `caseSalePrice`, genuine only when `>0 && < regular` and `saleEndDate` is a strictly valid, non-expired calendar date. Effective unit cost consumed by UI = active `salePrice ?? cost`. Map costs casePrice-first: `casePrice ?? piecePrice`.

**Why (two prior wrong beliefs, in order):**
1. First belief: "pieceSalePrice = net cost, piecePrice = MSRP" — false; left every not-on-sale style with cost null and blocked PO save. Only appeared to work because staples sit on rolling sales.
2. Second belief: "piecePrice = the account net cost" — also wrong. Tyler (shop owner) confirmed the real PC54 cost is $3.00 = casePrice; piecePrice was $4.00. The original Breezy app likewise used the Pricing service's casePrice as regular. (MSRP/retail actually lives in `mapPrice`.)

Live evidence (July 2026): PC54 Jet Black S–XL: piece 4.00 / pieceSale 2.44 / case 3.00 / caseSale 2.44, saleEnd 2026-07-12.

**How to apply:** Anywhere SanMar costs feed quotes/POs (Hub vendorLookup sanMarToColors and any revival of legacy PO Builder). Vendor responses can retain expired sale values, so re-check the date at the final pricing decision boundary; do not rely on sale-field presence alone or JavaScript's permissive date normalization. Caveat to surface to the user: broken-case (below case-quantity) orders may invoice at the higher piecePrice, so estimates can run slightly low there. No price is ever transmitted to vendors in PO submits — internal estimates only.

# SanMar combined-size labels

SanMar abbreviates combined sizes: `2XL/3XL` comes back as **`2/3X`**, `4XL/5XL` as **`4/5X`** — size-class letters appear only on the LAST token and distribute across bare-number prefixes (`S/M`, `L/XL` carry their own). When matching to a Printavo column by first component, a bare-numeric first token must borrow the trailing alpha suffix from the last token (`2/3X` → `2X` → 2XL), else it won't match `2XL`/`4XL` columns. Still first-component-only so two Printavo columns never claim one vendor unit (double-order risk).

# S&S Activewear (REST /products)

`piecePrice` = regular dealer cost. `salePrice` genuine only if >0, < piecePrice, and `saleExpiration` is a strictly valid, non-expired date. `customerPrice` mirrors salePrice during sales — never a baseline.

# SanMar plus-size color-bucket split

SanMar sometimes returns 4XL/5XL rows under a SEPARATE, abbreviated `catalogColor` ("AntqChryRd") from the S–3XL bucket ("Antqu Chry Red"), even though both share the same display `<color>` tag ("Antique Cherry Red"). Verified live on Gildan 5000.

**Why it matters:** the abbreviated bucket sorts alphabetically first and is plus-size-only, so any "first color" / "cheapest size" default can surface a plus-size price as the base garment cost (Tyler's rule: base price ALWAYS from XS–XL; plus-size upcharges are adjusted manually).

**How to apply:** do NOT merge these buckets server-side — inventory checks and PO submits require the exact per-bucket catalogColor string per size (merging risks wrong-color orders). Handle it at display time: prefer XS–XL-priced sizes/colors when picking a default price.

**Verified case-only exception:** Gildan 5400 returns Royal for smaller sizes
and ROYAL for larger sizes. Read-only live ProductInfo, inventory and
getPreSubmitInfo accepted either spelling for S and 2XL and resolved identical
per-size inventoryKey/sizeIndex and inventory. Case-only aliases can expose
the union of offers while retaining both names for saved approvals. This is
not permission to merge abbreviated, punctuated, heather, or dark variants;
conflicting same-size offers must stay ambiguous.

**Why:** Names differing only by case split one legitimate color across size
groups, causing false ambiguity. Preserving original alias names avoids
invalidating approved corrections; vendor pre-submit evidence establishes the
specific casing behavior rather than assuming display similarity implies identity.

# Vendor search quirks

- S&S `/styles/?search=` relevance can put the WRONG brand first when brands share a style number (bare "5000" → Bayside, not Gildan). Brand words typed in the query must outweigh S&S's own ordering.
- Printavo item numbers can carry a letter prefix OR suffix the vendor's catalog doesn't ("7610N" and "NL6211" — S&S lists Next Level styles as bare "7610"/"6211"; S&S search returns ZERO results for the decorated forms, verified live July 2026). Lookup strips letters off both ends of a token and keeps the digit core as a LAST-RESORT candidate, and such hits must always be labeled "closest" (never "exact") so the human double-check cue fires before ordering.
- SanMar SOAP has no keyword search — only exact style lookup. Multi-word queries need candidate fallback: KNOWN brand prefixes first ("bella 3001" → BC3001 — initials heuristics can't derive BC from "bella"; a small alias→prefix map is required and worth maintaining), then digit tokens as typed, then brand-initials+digits combos ("sport tek 350" → ST350). Each SOAP call is slow (15s+) and the edge proxy kills requests around ~48s, so cap fallback attempts; wrong candidates fail fast with "Invalid style". Digit-less queries ("bella jersey tee") are UNSEARCHABLE on SanMar — tell the user to include the number rather than pretending to search.
- Users misremember style numbers ("bella 3000" for the BC3001 jersey tee). Bare-number fallback hitting a DIFFERENT brand (SanMar "3000" = Gildan Light Cotton Tee) is fine ONLY because the closest-match warning fires when typed brand words don't match the result.
- CONFIRMED from SanMar integration guides (v16.10 + v18.8 PDFs, incl. PromoStandards option): NO keyword/free-text search exists in any SanMar API. Only: exact style(+color/size), full brand dump (getProductInfoByBrand, Bella+Canvas in list since ~v18), full category dump, and monthly-bulk/daily-delta full-catalog CSV dropped on SanMar's FTP (SanMarPDD folder; columns incl. PRODUCT_TITLE, PRODUCT_DESCRIPTION, KEYWORDS, BRAND_NAME, STYLE#). Keyword search must be built LOCALLY from a mirrored catalog (Postgres) — that's SanMar's intended integration pattern. Bulk limited to 1/month, delta 1/day.
- Exact-vs-closest labeling: match remaining query words against brand+title with WHOLE-WORD comparison only; substring matching lets "co" match "cotton" and suppresses the double-check warning.

## Evidence required for new style aliases

**Rule:** Finding a same-brand catalog product after removing a suffix does not establish manufacturer equivalence. Keep it review-required unless the user or an authoritative source confirms the alias.

**Why:** A live catalog check can prove both products exist without proving they are the same garment. Treating that as alias verification would turn an uncertain alternative into an automatically orderable product.

**How to apply:** When investigating future mismatches, distinguish verified catalog identity from verified equivalence before marking a nonliteral match exact.
