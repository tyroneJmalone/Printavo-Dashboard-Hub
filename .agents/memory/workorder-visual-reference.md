---
name: Workorder visual references
description: Use the actual Printavo workorder for Auto-Print formatting examples, not a redesigned fictional document.
---

Preserve the actual Printavo workorder layout when proposing Auto-Print changes. Place purchase date, vendor and warehouse beside the existing Goods Status at the bottom of the individual product line.

**Why:** The user rejected a fictional redesigned workorder because it looked nothing like Hub's printed output. They supplied standalone and direct-Printavo PDFs to ground the comparison.

**How to apply:** Use supplied workorder PDFs or actual renderer output as the visual base. Mark illustrative purchase details clearly; never imply they are verified. Distinguish a visual annotation from implemented Auto-Print behavior. Do not trigger printing or order-status changes to obtain a comparison.

AutoPrint omits production-file names/thumbnails (not production notes or product
images) and the Mint logo/company-address section. Move Customer Billing and
Customer Shipping into that section, to the left of PO number and dates, and
collapse the vacated space.
Put the QR code beside production notes, with the Work Order title below the
code, instead of retaining a separate top row.

**Why:** The user approved the compact real-workorder proof, then requested these
specific exceptions to reduce page count and toner usage.

AutoPrint workorders should use the existing UPDATED banner formatting with
the text "Rush/Firm Deadline" when the nickname matches firm, rush, or deadline.
Use the same case-insensitive keyword boundaries as status routing.

**Why:** The user requested nickname-triggered urgency highlighting, not a new
status rule or a changed workorder layout.

**How to apply:** Apply on initial prints and retries from the current nickname.
Preserve the UPDATED indicator on urgent reprints; do not trigger a new print
merely because the nickname changes.

**How to apply:** Scope these changes to AutoPrint, preserve customer contact
details and invoice notes, and keep the approved shading and UPDATED behavior.

## Proposed MERCH cover sheet

The user says MERCH/Chipply invoices follow production workflows differently.
They want MERCH-Ordered workorders to print and advance to decoration-specific
Waiting 4 Blanks statuses, with a custom cover sheet showing invoice number,
nickname, Production Due Date, Customer Due Date, and Order Status Name.
Below that heading they want the normally excluded product-image attachments
as a visual identifier, ideally on a single cover page.

**Why:** Staff need to quickly identify MERCH workorders visually.

**How to apply:** This is an architecture discussion, not approved implementation.
Verify the actual attachment source on an example invoice and clarify image
overflow handling. Keep regular workorders unchanged and retain safe
post-submission status timing; do not silently apply MERCH destinations to
non-MERCH invoices.

The user expanded the proposed cover-page scope to all other workorders as
well, while planning to use a Chipply feature for MERCH cover content. The
specific Chipply feature and input format are not yet identified.

Before proceeding, they want current Status added to post-AutoPrint destination
rule matching, mixed-decoration mapping according to line items, and MERCH
line-item decoration category assignment according to destination rules.
They pointed to the existing bulk select/assign category feature for reuse.

**Why:** MERCH production routing and line categories need coordinated handling.

**How to apply:** These are requested architecture changes, not implemented
behavior. Clarify mixed-line versus multi-method-on-one-line semantics.
Preserve individual line identity; a mixed invoice destination alone does
not identify each line's decoration. Missing-only assignment and explicit
per-rule cover selection are recommendations, not user-approved defaults.