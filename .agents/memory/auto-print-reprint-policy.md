---
name: Auto-print reprint and batch policy
description: User-approved reprint eligibility, legacy safety, skipped audit, and Hub PO copy semantics.
---

An automatic reprint requires BOTH a new return to an eligible Ordered/source
status after the prior print and changed line items. Re-entry alone or an edit
alone does not authorize another print. Reprints say UPDATED / REPRINT.

**Why:** The user chose this policy to handle customer additions without
reprinting unchanged orders on each purchasing/status cycle.

**How to apply:** Compare against the snapshot at the previous accepted print,
including quantities and prices but excluding workflow flags and timestamps.
No baseline means the comparison is unknown, not permission to reprint.
Missing historical skip identities cannot be reconstructed from run counts.
Printer acceptance is not proof of physical output; uncertain submissions
must not automatically resend.

Each auto-print run prints one copy of each relevant saved Hub PO represented
by workorders successfully submitted in that run, not one PO per invoice.

**Why:** The user requested a PO copy alongside its batch, while a single PO
can cover several workorders.

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