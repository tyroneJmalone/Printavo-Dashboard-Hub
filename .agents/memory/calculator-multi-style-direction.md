---
name: Calculator multi-style quoting direction
description: User's shared-artwork quoting workflow and proposed simplification of Printavo targeting.
---

The user often quotes more than one garment style with the same artwork/design printed or embroidered on them.

**Why:** They want to apply the same pricing matrix across several styles and push those styles as separate Printavo line items within one line-item group.

**How to apply:** Keep garment costs distinct while sharing decoration settings. The user also wants the invoice/quote selected under Push to Printavo to be the sole destination, without a separate required quote-number entry above. The user approved implementing the outlined expansion on October 19, 2026.

The user selected “Support both with an explicit choice” for decoration quantity breaks: separate tiers per style for alternatives, and combined quantities for a mixed order.

**Why:** Both workflows must be supported rather than silently assuming that multiple styles are alternatives or a combined run.

**How to apply:** Expose an explicit pricing-mode choice and keep garment costs separate in either mode. Do not infer combined-run eligibility merely from multiple garments being present.

The user also asked to explore creating a new Printavo quote from the calculator by selecting the client, alongside pushing to an existing quote, and asked whether category and imprint-location details carry through.

**Why:** The intended discussion covers a complete quote handoff, not just a pricing attachment.

**How to apply:** Include new-quote creation and full category/imprint handoff in the approved scope. Preserve the distinction between a quantity-price schedule for alternatives and actual ordered quantities/unit prices for mixed orders.

Calculator pushes must leave new line-item Goods Status at **Unset**, including pushes into existing orders and new-quote creation in both pricing modes.

**Why:** The user tested and approved the calculator handoff, but explicitly said marking goods Needs Ordering at the pricing stage is premature.

**How to apply:** Do not treat a calculated quote, even with quantities, as authorization to start purchasing. This rule is specific to the Price Calculator; do not silently change other quoting workflows or retroactively reset existing goods statuses.

The user wants Production Notes optional when attaching the calculator pricing PNG.

**Why:** Quantity/price tiers sometimes clutter Printavo's notes and are not always necessary.

**How to apply:** Let staff attach the PNG alone without changing or removing existing notes. Keep the same file deduplication and uncertain-attempt locks when the notes choice changes; the choice is not a new attachment identity.
