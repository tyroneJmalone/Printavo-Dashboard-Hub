---
name: Chipply revenue separation & live linking
description: Chipply web-store module invariants — revenue isolation and no-link-table design.
---

**Rule 1:** Chipply dollars (total/fundraising) live ONLY in `chipply_stores` and must NEVER be summed into any Printavo revenue report. The Printavo invoices linked to a Chipply store are $0 merch shells.
**Why:** Tyler explicitly requires Chipply revenue tracked separately; double-counting or mixing would corrupt every revenue report.
**How to apply:** Any new report/aggregate touching invoices or Chipply data keeps the two revenue streams in separate columns/sections, never one total.

**Rule 2:** Store→invoice links are DERIVED LIVE from the Printavo nickname prefix convention `"<eventId(5-7 digits)> <Store Name> <METHOD>:"` — there is deliberately NO link table.
**Why:** Architect-approved design so invoices renamed/added later in Printavo self-link with zero maintenance; a link table would silently drift stale.
**How to apply:** Don't "optimize" by materializing links. If perf ever matters, cache — never persist as source of truth. Parser was built from ONE sample email, so the UI review step must stay mandatory.
