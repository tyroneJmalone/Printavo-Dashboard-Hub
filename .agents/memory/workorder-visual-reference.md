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

## MERCH and general cover-sheet scope

The user says MERCH/Chipply invoices follow production workflows differently.
They want MERCH-Ordered workorders to print and advance to decoration-specific
Waiting 4 Blanks statuses, with a custom cover sheet showing invoice number,
nickname, Production Due Date, Customer Due Date, and Order Status Name.
Below that heading they want the normally excluded product-image attachments
as a visual identifier, ideally on a single cover page.

**Why:** Staff need to quickly identify MERCH workorders visually.

**How to apply:** The user subsequently authorized cover-sheet implementation,
MERCH/mixed destination mapping, and MERCH category recognition/assignment.
Preserve the existing detailed workorder behind the cover and safe
post-submission status timing; do not silently apply MERCH destinations to
non-MERCH invoices.

The user expanded the proposed cover-page scope to all other workorders as
well. They corrected the earlier Chipply idea: Printavo workorders will provide
the necessary information for cover sheets, including MERCH covers.

Before proceeding, they want current Status added to post-AutoPrint destination
rule matching, mixed-decoration mapping according to line items, and MERCH
line-item decoration category assignment according to destination rules.
They pointed to the existing bulk select/assign category feature for reuse.

**Why:** MERCH production routing and line categories need coordinated handling.

**How to apply:** Both mixed-line and multi-method-on-one-line cases are required.
Preserve individual line identity; a mixed invoice destination alone does
not identify each line's decoration. Preserve existing categories; require
explicit all-lines scope before using invoice-level method labels to fill
blank merchandise categories.

Cover sheets must be limited to one 8.5×11 portrait page, scaling images to
fit. Put the status next to the workorder number at the same size, without
a status label, and make due dates larger.

Show only the beginning status descriptor on covers: e.g. MERCH - Mixed Deco,
MERCH - Print, or PRINT / EMB / HEAT for non-MERCH workorders, not the workflow stage.

**Why:** The user revised the header to identify the production type rather
than display the full status name.

**Why:** After approving the real-invoice preview, the user explicitly required
one page rather than image continuation pages.

The user says most mixed jobs have one line using multiple methods.
Occasionally a separate line is made for its own decoration: for example,
24 sweatshirts receive the same screen print, but only six receive embroidery
personalization. The six must be split out because the additional decoration
is charged only to that subset.

**Why:** An invoice-wide category assignment would erase the distinction
between decoration methods and the quantities actually receiving them.

**How to apply:** Preserve recorded line/group relationships and subset
quantities. Do not apply embroidery to all 24 or assume an additional
decoration charge represents six additional physical garments.

MERCH sample records inspected during this discussion had blank line
categories and blank imprint methods/matrices, despite explicit EMB/HEAT
or PRINT location clauses in their nicknames.

**Why:** Requiring existing categories or matrices for every MERCH routing
decision would leave these imports unmatched. A nickname can identify
invoice-level methods without proving their applicability to every line.

**How to apply:** Consider narrowly defined nickname-method conditions as
explicit rule inputs, not blanket authoritative per-line evidence. Preserve
review handling for conflicting evidence and subset personalization.