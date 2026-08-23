---
name: Printavo quote vs invoice identity
description: Quote→invoice conversion changes the Printavo id; Quote.visualId is a String; QuoteInput supports productionNote
---

Facts verified live via read-only GraphQL introspection (Aug 2026):

- `quoteUpdate(id, input: QuoteInput!)` exists; `QuoteInput` includes `productionNote` (the type is named `QuoteInput`, NOT `QuoteUpdateInput` — introspecting the wrong name returns empty and looks like the field is missing).
- `Quote.visualId` is a **String** in the Printavo schema while `Invoice.visualId` is an Int — normalize with `Number()` before comparing.
- `productionFileCreate(parentId: ID!, publicFileUrl)` takes a generic parent id and works for quotes and invoices.

**Conversion changes identity:** when a quote converts to an invoice, Printavo issues a NEW internal id for the invoice; only the visual number is preserved. The Hub mirror reconciles this by deleting the quote row and inserting the invoice row (see sync upserts, `converted` event). Consequence: any stored reference to a quote's printavo id goes permanently stale on conversion.

**How to apply:** features that hold a quote's printavo id across time (upload reservations, links, queues) must either re-resolve by visual number or fail closed with a "converted — re-select" message before consuming any one-attempt mutation lock. The calculator push does the latter deliberately (no silent write redirection).
