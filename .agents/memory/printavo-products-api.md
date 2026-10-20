---
name: Printavo standalone products API
description: Live GraphQL product-search capabilities, limitations, and the distinction between the current library and historical line items.
---

# Printavo standalone products API

Printavo GraphQL exposes a root `products(query: String!, after, before, first, last)` connection. A `Product` exposes only `id`, `brand`, `color`, `description`, `itemNumber`, and `catalog { id name }`.

The connection is useful for current product identity and color variants, including entries in Printavo's `Custom` catalog. It does **not** expose costs, selling prices, sizes, inventory, or product images, so it cannot by itself power automatic quote pricing or a complete visual product catalog.

Historical order line items are broader than the current product library. A brand/style can appear many times in old line-item text while having no current result in `products`. Treat order history as evidence of past use, not proof that a product is currently selectable.

Search pagination is non-standard: a brand query requested with `first: 100` returned 25 nodes and `hasNextPage: false` even while `totalNodes` reported hundreds. Exact style searches were reliable in the probes; do not assume a brand search exhaustively enumerates the library or trust `totalNodes` as a matching-result count without more validation.

Further live checks found style searches returning 25 nodes with `hasNextPage: true` but `endCursor: null`; requesting edge cursors failed with a non-nullable cursor error. Empty searches are rejected. Style-plus-color searches can return unrelated colors and duplicate-looking variants, so search ranking is not exact-match proof. Do not promise full enumeration through standard cursors.

Live introspection confirms `LineItemCreateInput` and `LineItemInput` accept `product: IDInput` (with `id`), separately from itemNumber/color, and optional `priceReceiptSignature`. A read-only `lineItemGroupPricing` query also exists with `LineItemGroupPricingInput`; its line pricing input accepts product references. The Product object itself lacks cost fields, but this does not mean the API has no pricing capability. Investigate the pricing query before proposing a write test or claiming a product ID alone reproduces Refresh.

Read-only pricing probes reproduced the user's zero-product-cost failure without a product reference, and reproduced the manually entered line's full garment-plus-decoration price with the product reference alone (no incoming receipt signature). Quantity changes selected a different imprint tier; 2XL selected a higher garment cost. A mixed Small/2XL line priced all units using the higher garment cost in that probe, not a weighted average. Two lines sharing a group used the combined decoration tier. An explicit input selling price was ignored by the pricing query, and a linked zero-quantity line still returned $0 product cost plus decoration charges.

**Why:** Native Printavo recalculation is not equivalent to preserving the Hub's reviewed selling price, cost choice, or alternative-style schedules.

**How to apply:** Keep catalog linking distinct from choosing which pricing engine sets the initial price. Do not run native recalculation on Compare-mode zero-quantity descriptive lines.

An authorized live test on the designated test order verified that creating a line with `product: {id}` and an explicit selling price persists the catalog association without a receipt. Editing quantities preserves that association. Pricing from the persisted product and quantities then yields a valid receipt that can be saved successfully.

**Why:** Printavo rejects a line write containing both `price` and `priceReceiptSignature` (422). Sending the receipt signature alone sets both the selling price and stored breakdown. Creating with a plain price instead leaves receipt price/description null.

**How to apply:** Choose either reviewed Hub price or native Printavo receipt per write, never both. Catalog-linked creation, quantity edits, API recalculation, and receipt persistence were verified live; the actual browser Refresh Pricing button was not exercised. Keep that distinction explicit.

**Why:** Live schema and data probes found current custom Cap America, AS Colour, and Cotton Heritage variants, while historical Charles River lines did not resolve through exact style searches. The API's limited fields and odd search pagination make a naive catalog integration incomplete and potentially misleading.

**How to apply:** Use exact normalized style searches for lookup, keep current Printavo products separate from historical line-item suggestions, and pair custom products with a separate/manual source for cost, sizes, inventory, and images before allowing automatic quote selection.

The user reports that both Price Calculator and AI Quote Drafts pushes display the correct style, but changing size quantities and using Printavo Refresh produces a $0 garment cost while matrix imprint charges still populate.

A read-only comparison of a user-supplied live quote confirmed the Hub line had `product: null`, while the manually entered matching style/color had a SanMar catalog product. Quantities and imprint matrix columns matched; the live pricing receipts showed $0 versus a nonzero product cost. The missing product link is confirmed, but the API write requirements for recreating fully refreshable pricing still need verification.

**Why:** An initially correct selling price is not proof that the line supports Printavo's later product-cost recalculation.

**How to apply:** Investigate Printavo catalog identity and refreshable cost data together. Verify the live API write contract and compare with a manually catalog-selected line before promising that attaching a product ID alone fixes Refresh. No live record repair or change to pricing policy was authorized by this report.