---
name: BreezyMock reference app
description: Takeaways from Tyler's separate BreezyMock SaaS repo (mockup/proofing canvas) — lineItemMockupCreate mutation, temp-URL upload pattern, S&S/SanMar image endpoints, proofing canvas schema. Reference only, never integrated.
---

# BreezyMock (separate SaaS, reference only)

Reviewed July 2026 from a temporarily-public repo (tyroneJmalone/BreezyMock, private again afterward). Canvas-based mockup/proofing tool: composites vendor garment images + artwork, exports to Printavo. Same standing intent as Breezy Tweak: reference only, door open to borrow ideas.

## Printavo mutations for mockups/files (completes the file-push picture)
- `lineItemMockupCreate(lineItemId: ID!, publicImageUrl: String!)` — attaches a mockup to a SPECIFIC line item (not the order). Complements `productionFileCreate(parentId, publicFileUrl)` which attaches at order level.
- Both use the fetch-from-public-URL pattern (no binary upload). BreezyMock serves temp URLs from an in-memory store with 1-hour TTL; upload wrapped in a 3-attempt retry with 3s delay on timeouts (Printavo's fetch can be slow).
- Order search is two-step: `orders(query:, first: 10)` for IDs, then `order(id:)` per hit for lineItemGroups/lineItems detail. `productionFiles(first: 25)` lists existing attachments.
**How to apply:** if the Hub ever attaches mockups per line item (Print Queue / proofing), use lineItemMockupCreate, keep the temp-URL + retry pattern, and expect per-order detail fetches.

## Vendor garment imagery (useful beyond pricing — Hub PO/mockup features)
- S&S Activewear REST, Basic Auth (account# : API key): `/v2/styles` search → `/v2/products` for color-specific images (Front/Back/Side/Model views) AND per-color hex values.
- SanMar SOAP `getProductInfoByStyleColorSize`: view-specific images (`frontFlat`, `backFlat`, `colorProductImage`); parse with xml2js stripPrefix.
- Vendor color hexes could chain into the Hub color catalog's Delta-E matcher (garment color ↔ Pantone).

## Proofing canvas model (if Hub ever builds proofing)
- Tables: proofingProject (canvas dims, templateUrl) + canvasLayer (type: template/product/artwork/text; x/y/w/h, zIndex, opacity, rotation, visible/locked/pinned/flipX/flipY, text props, groupName).
- Export renders client-side at 300 DPI to blob; named layer groups export as separate `[project]-[group].png` files; JPEG q0.92 for Printavo, PNG for cloud storage.
