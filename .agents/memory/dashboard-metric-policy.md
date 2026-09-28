---
name: Dashboard metric definitions
description: User-approved Repeat Customer semantics and conservative reporting boundaries.
---

The dashboard label is **Repeat Customer**, not Reorders. It means qualifying
quote/invoice orders from a customer with a prior qualifying logical order, not
distinct returning customers and not proof of a repeated design/job. Ignore
ARCHIVE, DUPLICATED, and REFERENCE statuses case-insensitively.

**Why:** The user explicitly selected returning-customer orders and required both
quotes and invoices on September 25, 2026. A quote becoming an invoice must not
be treated as a second customer order merely because Printavo changes its ID.

**How to apply:** Keep this definition visible; do not substitute invoice-only
repeat business or count distinct customers. Treat customer + visual number as
a conversion-aware identity heuristic, not a guaranteed global identifier.
Report mirror-history and conversion-date limitations rather than inventing
original quote dates.

Use Eastern calendar periods with Monday-start weeks. The requested
periods are Today, WTD, LW, MTD, QTD, and YTD across performance, averages,
activity, and Close Rate. LW is the previous full Monday–Sunday, not rolling
seven days. Average Order Volume means pieces per order.
Decoration-method selections may overlap for mixed-method orders; whole-order
revenue is not allocated decoration revenue.

**Why:** These definitions separate order creation, cash collection, production
quantities, and observed sales-status changes, which have different clocks.

**How to apply:** Invoice-created totals and signed payment transaction-date
totals remain distinct. Items Decorated is recorded decorated-group quantity,
not proof of completed production. Recent wins require observed entry into the
pipeline won/done stages, not creation date or current status alone. Preserve
known-history caveats. Chipply revenue and shell-order behavior remain separate.

Close Rate uses quote-creation cohorts: eventually converted quotes divided by
all qualifying quotes created in the selected period. Exclude current statuses
containing any of Merch, Contract, Dead, Archive, Reference case-insensitively
from both numerator and denominator.

**Why:** The user wants actual quote-to-invoice conversion, not invoice count
divided by current open quotes. An invoice may be created after its quote's
reporting period ends. Older conversion events lack original quote dates.

**How to apply:** Keep unknown historical dates unavailable, never invent them
from invoice creation or observation time. Label observed-only rates as partial
coverage. Preserve original quote-date evidence atomically before removing
converted quotes, even during quiet seed runs; suppressing notifications must
not suppress historical evidence.