---
name: Printavo imprint matrix pricing
description: How pricing-matrix attribution interacts with quote totals and why live reference validation belongs before quote creation.
---

Attaching a Printavo pricing-matrix column to an imprint does not add a separate charge when the quote already supplies explicit line-item prices. Keep the Hub-reviewed unit price on each line item and attach the matrix column only for imprint attribution.

**Why:** Live schema inspection shows `ImprintCreateInput` accepts `pricingMatrixColumn` but has no price field, and existing Printavo quotes with matrices total exactly from line-item price × quantity. Hub matrix UUIDs are unrelated to Printavo IDs. The backup reference table also retains deleted entities, so it cannot prove an ID is still current before a non-idempotent create.

**How to apply:** Resolve Hub matrix names and column labels against the live, paginated Printavo pricing-matrix connection before claiming a quote draft. Require one exact normalized match, fail closed on missing/duplicate/malformed data, then send the live column ID while leaving the reviewed line-item price unchanged.

For automatic embroidery tier selection, `K` means one thousand stitches. At a shared endpoint, use the tier whose lower bound equals the stated count: 12K belongs to 12K–13K, not 11K–12K. Auto-select only from one exact, explicitly stitch-qualified count; leave ranges, bounds, approximations, conflicts, and missing counts unselected.

**Why:** The configured embroidery columns share endpoints, and the requested shop rule explicitly assigns 12K to the tier beginning at 12K. Treating non-exact language as exact can silently underprice embroidery.

**How to apply:** Preserve the stitch count in extracted decoration details, parse it deterministically, give exact lower-bound matches precedence, and fail closed to staff review whenever the count is not singular and exact.