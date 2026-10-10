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
Orders Report presets follow the same rule: Today/Yesterday are civil dates,
LW is the previous Monday–Sunday, LM is the previous calendar month, LQ is
the previous Jan–Mar / Apr–Jun / Jul–Sep / Oct–Dec quarter, and LY is the
previous January–December year. To-date periods start at the corresponding
calendar boundary. Never replace these with rolling 7/30/90/365-day windows.

**Why:** The user explicitly reaffirmed calendar-based Orders Report presets.

**How to apply:** Preserve these semantics in future report preset changes.

All reporting/date-filter surfaces in Hub should include Today, Yesterday,
WTD, LW, MTD, LM, QTD, LQ, YTD, and LY, while preserving custom ranges and
existing useful choices. This includes dashboard performance, averages,
activity, and Close Rate. LW is the previous full Monday–Sunday, not rolling
seven days. Average Order Volume means pieces per order.
Decoration-method selections may overlap for mixed-method orders; whole-order
revenue is not allocated decoration revenue.

**Why:** These definitions separate order creation, cash collection, production
quantities, and observed sales-status changes, which have different clocks.
The user requested the full preset set consistently across reporting modules.

**How to apply:** Invoice-created totals and signed payment transaction-date
totals remain distinct. Items Decorated is recorded decorated-group quantity,
not proof of completed production. Recent wins require observed entry into the
pipeline won/done stages, not creation date or current status alone. Preserve
known-history caveats. Chipply revenue and shell-order behavior remain separate.

Performance-by-period values must let users inspect included invoices and/or
customers. Details must use the same metric populations as the displayed totals;
net payments show signed transactions, and Repeat Customer shows qualifying
orders rather than distinct customers.

**Why:** The user requested visibility into the records behind each statistic.

**How to apply:** Preserve date basis, exclusions, conversion deduplication,
missing-quantity caveats, and pagination; do not substitute a broader report
whose population differs from the selected dashboard metric.

Close Rate uses quote-creation cohorts: eventually converted quotes divided by
all qualifying quotes created in the selected period. Exclude current statuses
containing any of Merch, Contract, Dead, Archive, Reference case-insensitively
from both numerator and denominator.

**Why:** The user explicitly confirmed that EVERY invoice starts as a quote.
Thus converted invoices remain in the original quote population: denominator
is eligible open quotes plus eligible invoices, numerator is eligible invoices.
Do not gate conversion on observed change events or current won status.
Counting remaining quotes alone produced the misleading small denominator.
This supersedes the intermediary pipeline-status-only interpretation.

**How to apply:** Count each logical order once. Prefer preserved original quote
creation dates, including conversions after the selected period ends. Older
invoices lack verified original quote dates: stored Printavo creation dates
can supply estimated period allocation, but rates using them MUST be labeled
estimated and disclose how many invoice dates are unverified. The all-invoices-
began-as-quotes business rule establishes origin, not timestamp preservation.
Do not call this an exact historical cohort rate or reintroduce an all-null
gate solely because conversion events are absent. Zero denominator remains
unavailable, not zero. Quotes Created activity should include converted quotes
consistently with the same eligible population and date caveat.
Preserve original quote-date evidence atomically before removing
converted quotes, even during quiet seed runs; suppressing notifications must
not suppress historical evidence.

Use the same retained original quote date for Repeat Customer ordering and
period allocation as for quote cohorts, while keeping their different status
exclusions. Changing only the reporting period still leaves the customer's
first and repeat orders incorrectly ranked after conversion.

**Why:** Invoice creation can occur after a customer's next quote, reversing
the apparent chronology even when logical-order deduplication is correct.

**How to apply:** Preserve explicit estimated fallback labeling for legacy
invoices; the earliest retained conversion observation describes evidence
coverage, never an original creation timestamp or continuous history guarantee.