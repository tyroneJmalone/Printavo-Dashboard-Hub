---
name: Chipply revenue separation & live linking
description: Chipply web-store module invariants — revenue isolation and no-link-table design.
---

**Rule 1:** Chipply dollars (total/fundraising) live ONLY in `chipply_stores` and must NEVER be summed into any Printavo revenue report. The Printavo invoices linked to a Chipply store are $0 merch shells.
**Why:** Tyler explicitly requires Chipply revenue tracked separately; double-counting or mixing would corrupt every revenue report.
**How to apply:** Any new report/aggregate touching invoices or Chipply data keeps the two revenue streams in separate columns/sections, never one total.

**Rule 1b — shells distort COUNTS too, not just revenue** (Tyler, Jul 25 2026): the $0 shells carry real garment line items, so they inflate invoice counts, order frequency, first/last dates, pieces-per-order, and top styles. Exclude them from behavioral stats with `(nickname IS NULL OR nickname !~ '^\d{5,7}\s')` — use `notChipplySql()` in the chipply matching lib. INTENTIONAL exceptions: order-history lists and status filters still show shells (browsing views). Do not assume every legacy report has this exclusion; verify each aggregate. Accepted risk: a legit nickname starting "12345 " would be silently excluded from stats.

**Rule 1c — excluded ≠ banished** (Tyler, Jul 25 2026): shell production data (invoice counts, pieces, styles) must stay VISIBLE in Chipply-specific displays, just never mixed into Printavo stats. Use `chipplySql()` (exact inverse of `notChipplySql()`) so the two views always partition the invoice set. Chipply style rankings sort by pieces (production volume); Printavo "Common styles" sort by order count (buying habit) — intentional difference, keep it.
**How to apply:** when excluding shells from any new Printavo aggregate, ask whether the excluded slice needs a Chipply-side counterpart display.

**Rule 2:** Store→invoice links are DERIVED LIVE from the Printavo nickname prefix convention `"<eventId(5-7 digits)> <Store Name> <METHOD>:"` — there is deliberately NO link table.
**Why:** Architect-approved design so invoices renamed/added later in Printavo self-link with zero maintenance; a link table would silently drift stale.
**How to apply:** Don't "optimize" by materializing links. If perf ever matters, cache — never persist as source of truth. Parser was built from ONE sample email, so the UI review step must stay mandatory.

**Method abbreviations** (Tyler, Jul 25 2026): the METHOD token in nicknames = decoration method. Tyler's sample gave EMB/SP/DTF, but a full survey of shell nicknames (Jul 25 2026) shows the REAL vocabulary is EMB (Embroidery), HEAT (Heat Applied Graphics), PRINT (Screen Printing), with SCREEN/SP/DTF/ENGRAVED rare. Map PRINT/SCREEN/SP→Screen Printing, HEAT/DTF→Heat Applied Graphics, ENGRAVED→Engraving. Keep the SQL mapping (customer profile) and the frontend decodeMethod in sync — never build token lists from one sample.

**Chipply has TWO ids** (from real exports, Jul 25 2026): the **Sales Order #** (e.g. 553498) is what appears in Printavo nickname prefixes = our `event_id`; the store **eid** (e.g. 351861) appears only in chipply.com URLs. Never conflate them.

**Export field traps**: SalesReport CSV appends a summary row with a BLANK Store Name duplicating the totals — skip nameless rows; money comes as 4-decimal strings; the email's "Total Dollars" = Sell Price, NOT the CSV's Order Total (which adds shipping/handling/tax).

**Category recommendations use invoice STATUS, not nickname method.**
**Why:** The user requested bulk category correction to avoid maintaining Chipply-imported line categories manually and to enable decoration/quantity reporting. Nicknames identify the invoices; statuses supply the proposed decoration category. Actual account statuses observed 2026-09-28 contain `MERCH - PRINT`, `MERCH - EMB`, and `MERCH - HEAT`, including completed stages, not merely the unhyphenated labels in the request.
**How to apply:** Keep review/confirmation before upstream edits, preserve existing categories unless explicitly approved for overwrite, and support manual assignment for ambiguous/unmapped statuses. These production classifications do not authorize combining Chipply revenue or behavior metrics with Printavo's other orders.
