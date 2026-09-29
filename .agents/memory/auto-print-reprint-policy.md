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