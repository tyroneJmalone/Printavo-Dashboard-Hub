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
