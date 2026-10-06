# Invoice profitability page — discussion and future plan

Logged October 6, 2026.

## Status and user intent

**Deferred. Discussion recorded only; implementation is not approved.**

The user proposed a module for job profitability insights: initially show an invoice's line-item revenue alongside the respective vendor costs, and break revenue into garment markup and imprint charges. Labor and supplies logic would be a possible later addition.

The user asked for ideas, an approach, and information needed before building. After reviewing the discussion, they asked: “Let's thoroughly log the invoice profitability page discussion and come back to it later.”

The questions about initial cost sources, current pricing practices, and sample invoices were not answered. The question form was dismissed. No cost-source choice or pricing assumption should be treated as approved. No profitability page, schema, integration, or reporting behavior was implemented.

## Overall recommendation and reasoning

This is feasible and useful with data already present in the Hub, but the first version should distinguish **margin before labor and supplies** from actual job profit.

The main challenge is not displaying revenue and costs. It is proving that a historical garment/imprint split is correct and establishing whether recorded purchase costs cover every sold unit. A polished report with unsupported allocations or missing costs treated as zero would be misleading.

Suggested module name: **Job Profitability**. Suggested initial result label: **Margin before labor and supplies**. These are recommendations, not approved names.

## What the code inspection established

### Invoice line revenue

The Hub mirrors invoice line-item quantities, selling prices, styles, colors, and sizes. These provide a starting point for revenue calculations. The report would still need to reconcile discounts, fees, rounding, and the invoice total rather than assuming every amount belongs to a garment row.

### Vendor purchase costs

Saved Hub POs contain per-size unit costs and quantities with invoice and line-item references. These can support exact matching to purchased garments, including different size costs and multiple purchases for one invoice line.

These records should be called **recorded PO costs**, not automatically “final actual costs.” They may not capture vendor-billed freight, subsequent adjustments, credits, or other changes. A saved but unsubmitted PO is also not proof that purchasing occurred; qualifying purchase states should be established during validation.

The team has previously explained that not all ordering occurs through Hub Purchasing. Historical coverage therefore needs explicit investigation; a Hub-only first version could have significant gaps.

### Garment and imprint revenue separation

The Hub quote builder already calculates garment cost, garment markup, decoration pricing, final unit price, and line totals separately. This is a promising source for Hub-created quotes, provided the original quote is verifiably linked to the invoice and later pricing changes are accounted for.

The inspection does **not** prove that every invoice has a recoverable breakdown.

For older or directly created Printavo invoices, the API exposes markup and pricing-receipt information. Representative examples are needed to determine which values can be recovered reliably and what they mean in the existing pricing workflow.

Important Printavo caveat: attaching a pricing-matrix column to an imprint does not by itself establish an additional charge to add to an explicitly priced line item. Matrix attribution must not be double-counted as revenue. Likewise, current matrix prices should not be presented as verified historical charges.

Some existing quote-builder variables use “decoration cost” terminology for the amount added to the customer's price. In this report, that amount should be described as **imprint/decoration revenue**, not internal production expense.

## Proposed first-version page

### Invoice lookup and summary

Find an invoice and open its profitability detail.

Proposed top-level figures:

- Line-item revenue, excluding sales tax.
- Matched garment purchase cost.
- Revenue remaining after garment purchase cost.
- Margin before labor and supplies.
- Cost coverage, such as **“92 of 100 units have matched purchase costs.”**

Incomplete coverage should be prominent. Do not display an unqualified whole-job margin when missing costs could materially overstate it.

### Line-level breakdown

Proposed information for each invoice line:

| Field | Purpose |
|---|---|
| Style, color, size, and quantity | Identify what was sold |
| Unit selling price and line revenue | Show the customer charge |
| Vendor and PO reference | Trace purchase evidence |
| Ordered quantity and unit cost | Explain matched garment cost |
| Garment selling amount | Show the garment portion of pricing, where supported |
| Garment markup dollars | Explain the markup above the original garment pricing basis |
| Imprint charges | Show revenue attributed to decoration |
| Remaining margin | Compare revenue with recorded purchase costs |

Expandable rows could show multiple POs, size-specific prices, partial purchasing, and the source of each amount.

Only positively matched PO lines and quantities should be included. Matching should not rely merely on similar garment descriptions or shared invoice display numbers. Quote conversion can change underlying Printavo IDs, so lineage must be verified.

### Source and confidence labels

Suggested labels:

- **Recorded PO cost**
- **Original quote pricing**
- **Current catalog estimate**
- **Manually supplied**
- **Missing / cannot separate**

These labels should describe the evidence, not imply verification that has not happened.

**Missing cost must never become zero cost.** Otherwise an incompletely purchased job could look unusually profitable.

Current catalog pricing may be a useful fallback, but it is an estimate of today's cost, not proof of the historical purchase price. The user has not approved that fallback.

## Calculation model and distinctions

At the simplest line level:

- Line revenue = sold quantity × selling price, subject to actual invoice adjustments.
- Recorded garment purchase cost = sum of matched purchased quantities × recorded unit costs.
- Revenue remaining after garment cost = relevant revenue − matched garment cost.
- Margin percentage, where coverage and revenue basis are valid = remaining amount ÷ relevant revenue × 100.

The garment/imprint decomposition is a breakdown **within** line revenue, not additional revenue:

- Garment selling amount + imprint charges = line revenue before separately accounted adjustments.
- Garment markup = garment selling amount − original garment pricing cost basis.

Distinguish **the cost used when quoting** from **the amount ultimately paid**. A vendor discount or price increase affects realized contribution; it should not silently rewrite the customer's original garment/imprint pricing split. If useful, display the purchasing variance separately.

### Example discussed

Illustrative only; not data from a real invoice:

| Component | Amount |
|---|---:|
| 100 pieces sold at $12 each | $1,200 revenue |
| Garment portion at $5 each | $500 |
| Imprint portion at $7 each | $700 |
| Original garment basis and purchased cost at $3 each | $300 |
| Garment markup | $200 |
| Revenue remaining after garment cost | $900 |

The $900 comprises $200 garment markup plus $700 imprint revenue in this example. It is **not net job profit**: labor, ink/thread, other supplies, freight, overhead, and other applicable costs have not been deducted.

If the purchased cost differs from the original $3 pricing basis, original markup and realized margin no longer have that same relationship without a separately shown purchasing variance.

## Invoice adjustments and reconciliation

Recommendation: show discounts, customer shipping charges, setup fees, other fees, and tax separately, with a reconciliation to the invoice total.

Do not silently allocate these amounts across garment rows. If allocation is later wanted, the method should be explicit and consistently applied.

Customer shipping revenue is not vendor freight expense. Imprint revenue is not decoration labor or supplies expense. Sales tax should not inflate revenue or margin.

The first version can be useful without modeling every cost, provided excluded costs are clearly disclosed.

## Proposed phased approach

### Phase 1 — Validate real examples

Inspect a few representative invoices and compare:

- Printavo line prices, quantities, markup, and available pricing receipts.
- Original saved Hub quote calculations, where present.
- Verified quote-to-invoice links and later invoice changes.
- Corresponding Hub PO snapshots and purchase states.
- Any existing records for purchases made outside the Hub.

Deliverable: establish which costs and revenue splits can be treated as recorded facts, which are estimates, and which are unavailable.

### Phase 2 — Invoice detail page

Start with line revenue versus matched purchase costs, cost coverage, and source labels. Add the garment/imprint split only where evidence supports it.

Keep unrelated invoice lines out of the purchase-cost match, and support partial or multi-PO matching without double-counting.

### Phase 3 — Cross-job insights

Add a searchable job summary with comparisons by customer, decoration type, or date. Distinguish complete-cost jobs from incomplete or estimated jobs before ranking margins.

This would let the team identify profitable work and investigate low-margin jobs without treating missing data as a business result.

### Phase 4 — Production cost model

Possible future additions:

- Labor standards and actual labor.
- Setup time.
- Ink, thread, and other consumables.
- Outsourced production.
- Spoilage and replacement garments.
- Freight and overhead, with explicit allocation rules.
- Estimated versus actual job margin.

These remain future options, not requirements approved for the initial build.

### Replacement-cost attribution idea

A useful later extension would attribute replacements ordered on internal invoice #22787 back to the original customer job.

This requires an explicit, verified association. A reference inside a free-text description should not automatically become an authoritative accounting link. Do not charge all replacement-invoice costs to one customer job or double-count them across jobs.

## Alternatives presented and left unresolved

### Initial purchase-cost source

1. **Saved Hub POs first:** simplest traceable starting point; clearly identify gaps.
2. **Include purchases outside the Hub:** broader coverage, but first determine what records exist and how to import or link them.
3. **Use catalog estimates for missing purchases:** improves coverage of estimates, but must remain visibly separate from recorded historical costs.

No option was selected.

### Current pricing workflow

We asked whether garment markup and imprint pricing currently come from:

- Printavo matrices.
- The Hub quote builder.
- A standard garment multiplier.
- Manually set total selling prices.

This remains unanswered. The answer materially affects how much historical decomposition is possible.

### Sample invoices

We requested two or three invoice numbers, ideally:

- A straightforward job.
- A job with multiple garments or sizes.
- A job with multiple imprint locations or another pricing complication.

No examples were supplied during this discussion.

## How to resume

Return to the unanswered source/pricing/example questions first. Inspect representative records read-only and reconcile the numbers before committing to a revenue-splitting algorithm.

Do not infer authorization to build from this log. The user's latest direction is to preserve the discussion and revisit it later.

### Technical starting points

Paths observed during the discussion; verify them when resuming:

- `lib/db/src/schema/pvLineItems.ts` — mirrored line items and selling prices.
- `lib/db/src/schema/pvOrders.ts` — invoice-level information.
- `lib/printavo/src/queries.ts` — line-item extras and pricing-receipt fields.
- `artifacts/api-server/src/lib/purchasing/poFiles.ts` — saved PO quantities, costs, and identities.
- `artifacts/api-server/src/lib/quoteDrafts/service.ts` — garment markup and decoration pricing calculations.
- `.agents/memory/printavo-imprint-matrix-pricing.md` — matrix attribution and double-counting caveat.
- `.agents/memory/vendor-pricing-semantics.md` — vendor-specific cost definitions.
- `.agents/memory/printavo-quote-vs-invoice-ids.md` — quote conversion identity caveat.

These are starting points for validation, not a completed implementation plan or proof that every needed historical field is available.
