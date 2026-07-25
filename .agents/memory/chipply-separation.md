---
name: Chipply revenue separation & live linking
description: Chipply web-store module invariants — revenue isolation and no-link-table design.
---

**Rule 1:** Chipply dollars (total/fundraising) live ONLY in `chipply_stores` and must NEVER be summed into any Printavo revenue report. The Printavo invoices linked to a Chipply store are $0 merch shells.
**Why:** Tyler explicitly requires Chipply revenue tracked separately; double-counting or mixing would corrupt every revenue report.
**How to apply:** Any new report/aggregate touching invoices or Chipply data keeps the two revenue streams in separate columns/sections, never one total.

**Rule 1b — shells distort COUNTS too, not just revenue** (Tyler, Jul 25 2026): the $0 shells carry real garment line items, so they inflate invoice counts, order frequency, first/last dates, pieces-per-order, and top styles (one customer: 31 invoices/734 pcs shown vs 4/227 real). Exclude them from behavioral stats with `(nickname IS NULL OR nickname !~ '^\d{5,7}\s')` — use `notChipplySql()` in the chipply matching lib. Applied to customer profile stats/qty/styles, directory counts, niche report; Ask AI schema doc instructs the same. INTENTIONAL exceptions: order-history lists and status filters still show shells (browsing views). Known gap left for a later decision: the general Orders report + dashboard counts still include shells. Accepted risk: a legit nickname starting "12345 " would be silently excluded from stats.

**Rule 2:** Store→invoice links are DERIVED LIVE from the Printavo nickname prefix convention `"<eventId(5-7 digits)> <Store Name> <METHOD>:"` — there is deliberately NO link table.
**Why:** Architect-approved design so invoices renamed/added later in Printavo self-link with zero maintenance; a link table would silently drift stale.
**How to apply:** Don't "optimize" by materializing links. If perf ever matters, cache — never persist as source of truth. Parser was built from ONE sample email, so the UI review step must stay mandatory.

**Method abbreviations** (Tyler, Jul 25 2026): the METHOD token in nicknames = decoration method — EMB = Embroidery, SP = Screen Printing, DTF = Heat Applied Graphics. Decode to friendly labels wherever methods surface in UI or reports.

**Chipply has TWO ids** (from real exports, Jul 25 2026): the **Sales Order #** (e.g. 553498) is what appears in Printavo nickname prefixes = our `event_id`; the store **eid** (e.g. 351861) appears only in chipply.com URLs. Never conflate them.

**Export field traps**: SalesReport CSV appends a summary row with a BLANK Store Name duplicating the totals — skip nameless rows; money comes as 4-decimal strings; the email's "Total Dollars" = Sell Price, NOT the CSV's Order Total (which adds shipping/handling/tax).
