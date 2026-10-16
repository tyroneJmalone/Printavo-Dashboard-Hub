---
name: Printavo quote vs invoice identity
description: Quote→invoice conversion can preserve or change the Printavo id; normalize visual identity and preserve date evidence in both paths
---

Facts verified live via read-only GraphQL introspection (Aug 2026):

- `quoteUpdate(id, input: QuoteInput!)` exists; `QuoteInput` includes `productionNote` (the type is named `QuoteInput`, NOT `QuoteUpdateInput` — introspecting the wrong name returns empty and looks like the field is missing).
- `Quote.visualId` is a **String** in the Printavo schema while `Invoice.visualId` is an Int — normalize with `Number()` before comparing.
- `productionFileCreate(parentId: ID!, publicFileUrl)` takes a generic parent id and works for quotes and invoices.

**Conversion may change identity, but does not always:** previously observed conversions issued a new internal ID; a live status-driven Quote → Print Complete conversion observed on 2026-10-16 preserved the internal ID, customer, visual number, and source creation timestamp.

**Why:** assuming every conversion replaces the ID misses same-ID classification changes and can discard the opportunity to preserve verified original quote dates.

**How to apply:** preserve original-date evidence for both existing-row quote→invoice updates and replacement-ID conversions. Never infer the original date from observation time. Features holding quote IDs must revalidate classification and customer/visual identity before a mutation; changed IDs require re-resolution or a fail-closed re-selection, not silent write redirection.
