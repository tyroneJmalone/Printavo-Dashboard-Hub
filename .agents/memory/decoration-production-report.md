---
name: Decoration production reporting direction
description: Approved production reporting, workload scheduling dates, completion evidence, and Merch scope.
---

The user wants to explore a decoration-locations statistic within Analyze →
Orders Report, functioning as a production log: invoice counts, decoration
methods, quantities, 1/2/3/etc. locations, and quantities multiplied by their
respective location counts to calculate total decoration applications per job.
Their example target includes average job quantity, average item sale price,
and location counts. The user subsequently requested each location's estimated
stitches instead of averaging stitches across locations.
The user approved implementing the initial Print and Embroidery report.

**Why:** Garment counts alone do not describe production workload; front-only,
front/back, and front/back/sleeve jobs require different numbers of applications.

**How to apply:** Calculate at line-item-group grain before rolling up invoices.
Do not multiply an entire invoice's quantity by all its imprints.
Distinguish recorded invoice workload from evidence of
actual completed production. Keep proposed calculations distinct from
user-approved decisions.

The user confirmed that each assigned Printavo imprint represents one physical
decoration location. For now, use the midpoint of the embroidery pricing tier
assigned to each imprint as its estimated stitch count: 6K–8K means 7K.
The user said they need a better system for documenting actual stitch counts
after production; that future capture system is not yet specified.

**Why:** These are the user's explicit answers about their recording practices
and preferred interim estimation method.

**How to apply:** Label tier-midpoint counts as estimated, not actual recorded
stitches. Keep missing or nonnumeric/unbounded tiers unknown rather than zero.
Keep future actual stitch-count capture distinct from interim invoice reporting.

Include a Print analysis alongside Embroidery. For Print, use colors per design
instead of stitch counts; the user states colors directly correlate to screens
needed for a job. Preserve per-location counts rather than averaging them away.
Exclude Heat for now: the user needs to revamp that pricing matrix first.

**Why:** The user explicitly refined the display and first-version scope.

**How to apply:** Show per-location embroidery tier midpoint estimates and
per-location Print colors. Separate screen/setup counts from quantity-weighted
production applications. Do not implement Heat analysis or silently include it
in the Print or Embroidery summaries.

Use the user's printing terminology: **impressions = number of colors ×
quantity**, calculated per location/group and summed for job totals.
Imprints (decoration applications) remain a separate metric.

**Why:** The user explicitly supplied the shop term and formula.

**How to apply:** Label quantity-weighted color applications as "Impressions,"
not "color applications" or screens. For 100 shirts with a three-color front
and one-color back, show 200 imprints and 400 impressions.

The user wants to look one or two weeks ahead at scheduled Print impressions
and imprints, and Embroidery stitches and decoration locations, using historical
daily/weekly production as a reference for intelligent scheduling and capacity.
The user confirmed Printavo Production Due is the scheduled work date.
Finished jobs move to decoration-specific Complete, Picked Up, Shipped, or
Delivered statuses. MERCH PRINT Pick/Pack Complete is also finished production.
Generic “Picked Up” also means completed; the user explicitly approved
classifying its production methods by line-item categories and pricing matrices.
This does not extend generic completion to Shipped, Delivered, or Complete.
Merch must be included in production statistics, with the ability to isolate
it or roll it into totals.

**Why:** The user's goal is to understand shop capacity, not just invoice volume.

**How to apply:** Keep Print and Embroidery workloads separate. Distinguish
historically scheduled volume from verified completed output, and observed
throughput from a proven capacity limit. Do not silently treat customer
deadlines as scheduled work dates or whole-invoice completion as evidence of
when each decoration method finished.
For generic pickup, classify the actual groups rather than assigning the invoice
to both methods from its status. Prefer location-level matrix/type evidence on
mixed jobs; use unambiguous garment categories as fallback. Missing completion
history remains undated, not a guessed completion on the production due date.

Historical comparisons attribute a job/method once to its first observed
completion transition, not again when it is picked up, shipped, or delivered.
If the oldest evidence already says it was finished, the finish date is unknown.
Do not substitute Production Due for an unknown completion date. A reopened
method can be pending again without inventing an additional historical run.

**Why:** Hub's change feed timestamps are observation times, not actual machine
finish times; its history starts later than many invoices. Current line-item
snapshots also do not prove what quantities existed at the time of completion.

**How to apply:** Label historical output as observed completion with current
invoice quantities; distinguish date-only Production Due (UTC calendar day)
from actual status-observation timestamps (Eastern civil time). Never describe
baseline output as a measured maximum capacity or guaranteed production hours.

Merch inclusion is a production-workload exception to the general exclusion of
Chipply shell invoices from financial/customer-behavior reports.

**Why:** These invoices describe real shop work even though their invoice prices
may be zero and their sales revenue lives in Chipply.

**How to apply:** Include physical quantities and decoration workload without
globally removing the shell exclusion or adding Chipply dollars to Printavo
revenue. Use invoice-level All / Non-Merch / Merch-only scope; do not present
zero-dollar shell prices as the actual store item sale prices.
