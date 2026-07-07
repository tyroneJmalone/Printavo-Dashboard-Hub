---
name: Breezy Quote pricing engine & vendor lookup clients
description: Exact price-calc formula, matrix data shape, and working S&S REST + SanMar SOAP client logic (incl. sale-price detection) for Hub's Breezy + PO Builder modules
---

# Pricing formula (must replicate exactly)
- Unit price = (garmentCost × markupMultiplier) + Σ decorationCost across up to 4 locations.
- Price break rule: sort breaks ascending by qty; walk up, keep last break where `break.qty <= qty` (highest qualifying tier wins; below the lowest tier uses the lowest tier's cost).
- Result rows come from the FIRST location's breaks (canonical qty tiers); other locations resolve their cost at that qty.
- Markup presets 1.0–2.0 in 0.05 steps, default 1.75; custom values allowed. Total order value = unitPrice × qty.

# Matrix data shape (jsonb `data` in `matrices` table: id text PK, name, data, timestamps)
`{ name, xAxisLabel, xValues: [{ label, breaks: [{ qty, decorationCost }] }] }`
- POST /api/matrices is an UPSERT when `id` supplied. CSV bulk import + starter matrices exist in UI.
- No auth, single-tenant, team-shared.

# S&S Activewear client (REST, proven)
- Base `https://api.ssactivewear.com/v2`, Basic auth `SS_ACCOUNT_NUMBER:SS_API_KEY`, 12s timeout.
- Lookup: `/styles/?search={style}` → prefer exact styleName match else first → `/products/?styleID={id}` → dedupe by colorName (first SKU per color).
- **Price field semantics (important)**: `piecePrice` = regular dealer price; `salePrice` = promo; `customerPrice` MIRRORS salePrice during sales so never use it as the regular baseline. Sale is genuine only if salePrice > 0 && < piecePrice && `saleExpiration` present.
- Image URLs are relative — prefix `https://www.ssactivewear.com/`.

# SanMar client (SOAP/XML, proven — also needed by PO Builder)
- Endpoints: `ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort` (getProductInfoByStyleColorSize) and `.../SanMarPricingServicePort` (getPricing). Header `SOAPAction: '""'`, Content-Type text/xml, 15s timeout.
- Auth block in every request body: sanMarCustomerNumber (164656) + sanMarUserName + sanMarUserPassword (env: SANMAR_ACCOUNT_NUMBER, SANMAR_USERNAME, SANMAR_PASSWORD).
- Parsing: regex over `<listResponse>` blocks (no XML lib); sub-blocks productBasicInfo/productImageInfo/productPriceInfo; fields catalogColor, piecePrice, inventoryKey, sizeIndex, colorSquareImage, colorProductImage.
- **Base-size trick**: per color keep entry with LOWEST catalog piecePrice → its inventoryKey+sizeIndex identifies base size (S–XL), avoiding 2XL+ upcharges when calling pricing API.
- Pricing semantics: `casePrice` = regular dealer net (stable during sales); `myPrice` = current account price; expose casePrice as regular + salePrice only if > 0, < casePrice, and saleEndDate present. Pricing call is best-effort — fall back to catalog piecePrice.
- Errors: `<faultstring>` = SOAP fault; `<errorOccured>true</errorOccured>` (note the typo spelling, check both spellings) + message containing "authenticat" = 401.

# Sale price UX rule
When a vendor returns a genuine sale price, show Regular/Sale toggle — user decides whether client gets the discount or shop keeps margin.

# Hub notes
- BreezyQuote is built on the SAME pnpm monorepo template as the Hub workspace (api-server + orval codegen + lib/db) — its route/schema code can port nearly verbatim.
- Secrets needed: SS_ACCOUNT_NUMBER, SS_API_KEY, SANMAR_USERNAME, SANMAR_PASSWORD, SANMAR_ACCOUNT_NUMBER.
- No Printavo integration in Breezy today; context doc suggests future flow: vendor cost + matrix calc → push into Printavo quote.
