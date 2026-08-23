---
name: Printavo standalone products API
description: Live GraphQL product-search capabilities, limitations, and the distinction between the current library and historical line items.
---

# Printavo standalone products API

Printavo GraphQL exposes a root `products(query: String!, after, before, first, last)` connection. A `Product` exposes only `id`, `brand`, `color`, `description`, `itemNumber`, and `catalog { id name }`.

The connection is useful for current product identity and color variants, including entries in Printavo's `Custom` catalog. It does **not** expose costs, selling prices, sizes, inventory, or product images, so it cannot by itself power automatic quote pricing or a complete visual product catalog.

Historical order line items are broader than the current product library. A brand/style can appear many times in old line-item text while having no current result in `products`. Treat order history as evidence of past use, not proof that a product is currently selectable.

Search pagination is non-standard: a brand query requested with `first: 100` returned 25 nodes and `hasNextPage: false` even while `totalNodes` reported hundreds. Exact style searches were reliable in the probes; do not assume a brand search exhaustively enumerates the library or trust `totalNodes` as a matching-result count without more validation.

**Why:** Live schema and data probes found current custom Cap America, AS Colour, and Cotton Heritage variants, while historical Charles River lines did not resolve through exact style searches. The API's limited fields and odd search pagination make a naive catalog integration incomplete and potentially misleading.

**How to apply:** Use exact normalized style searches for lookup, keep current Printavo products separate from historical line-item suggestions, and pair custom products with a separate/manual source for cost, sizes, inventory, and images before allowing automatic quote selection.