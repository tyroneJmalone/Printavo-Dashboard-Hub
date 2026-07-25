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

**Method abbreviations** (Tyler, Jul 25 2026): the METHOD token in nicknames = decoration method — EMB = Embroidery, SP = Screen Printing, DTF = Heat Applied Graphics. Decode to friendly labels wherever methods surface in UI or reports.

**Chipply has TWO ids** (from real exports, Jul 25 2026): the **Sales Order #** (e.g. 553498) is what appears in Printavo nickname prefixes = our `event_id`; the store **eid** (e.g. 351861) appears only in chipply.com URLs. Never conflate them.

**Export field traps**: SalesReport CSV appends a summary row with a BLANK Store Name duplicating the totals — skip nameless rows; money comes as 4-decimal strings; the email's "Total Dollars" = Sell Price, NOT the CSV's Order Total (which adds shipping/handling/tax).
