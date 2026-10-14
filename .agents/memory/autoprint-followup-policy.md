---
name: AutoPrint status and category correction policy
description: Rules for correcting accepted MERCH workorders without printing again.
---

The user approved an administrator preview-and-confirm correction for already
printed MERCH workorders using the current saved destination/category rules.
This is separate from print recovery: it must never render, print, or alter
the accepted-print audit to bypass duplicate protection.

**Why:** Workorders printed before their routing/category settings were properly
configured, so replaying printing is unnecessary and unsafe.

**How to apply:** Revalidate live invoice identity, details and status plus the
saved rules before confirmation; preserve nonblank categories. Block invoices
that progressed beyond their printed source or intended destination rather
than moving them backward. Preview/confirmation is actor-bound and one-shot.
Uncertain or partial outcomes remain held for manual verification, including
across restarts. Keep the category-review write protections and the existing
guarded status worker; never add a printer dependency to this correction path.

The user approved a narrow automatic post-check and one retry for missing-only
category assignments within a new MERCH AutoPrint/correction attempt. Read only
the uncertain lines; confirm the intended category without a new write when it
is present. Retry only a still-blank category on the same recognized invoice,
with unchanged status, nickname and line position and a valid official target.
Keep the line lock, persist the retry claim first, and read back the result.
Unreadable/conflicting data or a second uncertain outcome stays held. This does
not authorize replaying historical or interrupted holds, printing, status writes,
or general-purpose Printavo mutations.

**Why:** A single unconfirmed category can stop an otherwise successful correction;
the user requested targeted recovery rather than resending all assignments.

**How to apply:** Opt in only for missing-only MERCH automation. Printavo lacks
atomic compare-and-set, so warn against simultaneous upstream edits. A finished
worker is not necessarily a successful correction: show queued/review-required
outcomes until every invoice's changes are confirmed.
