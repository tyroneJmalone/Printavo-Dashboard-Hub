---
name: Auto-print reprint and batch policy
description: User-approved reprint eligibility, legacy safety, skipped audit, and Hub PO copy semantics.
---

An automatic reprint requires BOTH a new return to an eligible Ordered/source
status after the prior print and changed line items. Re-entry alone or an edit
alone does not authorize another print. Reprints say UPDATED at the top.

**Why:** The user chose this policy to handle customer additions without
reprinting unchanged orders on each purchasing/status cycle.

**How to apply:** Compare against the snapshot at the previous accepted print,
including quantities and prices but excluding workflow flags and timestamps.
No baseline means the comparison is unknown, not permission to reprint.
Missing historical skip identities cannot be reconstructed from run counts.
Printer acceptance is not proof of physical output; uncertain submissions
must not automatically resend.

Always exclude attachment pages from Auto-Print, while retaining the workorder's
product thumbnails and alternating whole-line shading.

**Why:** The user explicitly reiterated these requirements when approving the
compact workorder format on October 5, 2026.

**How to apply:** Do not let old saved settings re-enable attachment pages.
Preserve changed-lines-plus-reentry eligibility when adjusting the UPDATED label.

Each auto-print run prints one copy of each relevant saved Hub PO represented
by workorders successfully submitted in that run, not one PO per invoice.
For changed-line workorder reprints, include only associated POs created after
the previous successful workorder print. Do not repeat the original PO merely
because the workorder reprints, and do not treat editing an old PO as a new PO.

**Why:** The user requested a PO copy alongside its batch, while a single PO
can cover several workorders. They clarified that reprints need only the new
associated PO, if one exists.

**How to apply:** Preserve original PO snapshots and invoice links, deduplicate
POs within the run, and require verified conversion provenance before matching
an old quote-linked PO to a new invoice ID. Keep PO outcomes separate from
workorder outcomes so a PO failure does not cause duplicate workorders.

Internal replacement invoice 22787 must never receive an AutoPrint workorder
or a PO production-file attachment. Its lines and invoice reference must still
remain in the PO itself.

**Why:** The user uses this invoice to order replacements for factory defects
and production damage, not customer production work.

**How to apply:** Enforce the exception at workorder and attachment side-effect
boundaries, including retries. Do not remove PO lines, skip their purchasing
updates, delete existing attachments, or suppress a shared PO's customer work.

The user requested a draft of a replacement slip for 22787 containing only
invoice number, nickname, and the line details belonging to the PO being
processed. Full line descriptions carry pertinent replacement/fix instructions.
They approved the general draft appearance and additionally require PO number,
order date, vendor, and ordered-from warehouse. Use verified PO submission data;
do not infer an actual fulfillment warehouse from free-text ordering instructions.
If a PO uses multiple warehouses, retain the warehouse association per line.
The user subsequently approved enabling the slip on the next republish.
The full-workorder skip remains in force.

**Why:** This is an in-house replacement/fix record, not a normal customer
workorder; the entire invoice contains unrelated replacement lines.

**How to apply:** Scope by exact PO snapshot line IDs and quantities, not all
invoice lines. Queue prospectively on confirmed vendor ordering (including
manual confirmation), then use the next live AutoPrint run and its printer.
Do not backfill existing POs, print vendor previews/test orders, or resend
uncertain submissions. This trigger lets replacement-only POs print without
weakening the full-workorder exclusion.