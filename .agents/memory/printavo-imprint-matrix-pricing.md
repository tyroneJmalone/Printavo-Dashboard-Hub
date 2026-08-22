---
name: Printavo imprint matrix pricing
description: How pricing-matrix attribution interacts with quote totals and why live reference validation belongs before quote creation.
---

Attaching a Printavo pricing-matrix column to an imprint does not add a separate charge when the quote already supplies explicit line-item prices. Keep the Hub-reviewed unit price on each line item and attach the matrix column only for imprint attribution.

**Why:** Live schema inspection shows `ImprintCreateInput` accepts `pricingMatrixColumn` but has no price field, and existing Printavo quotes with matrices total exactly from line-item price × quantity. Hub matrix UUIDs are unrelated to Printavo IDs. The backup reference table also retains deleted entities, so it cannot prove an ID is still current before a non-idempotent create.

**How to apply:** Resolve Hub matrix names and column labels against the live, paginated Printavo pricing-matrix connection before claiming a quote draft. Require one exact normalized match, fail closed on missing/duplicate/malformed data, then send the live column ID while leaving the reviewed line-item price unchanged.