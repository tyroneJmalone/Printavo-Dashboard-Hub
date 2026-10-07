---
name: Decoration production reporting direction
description: Proposed Orders Report view of quantities, location counts, applications, and method-specific job averages.
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
The scheduling date and evidence of method-specific completion still need
confirmation; this extension has not yet been implemented.

**Why:** The user's goal is to understand shop capacity, not just invoice volume.

**How to apply:** Keep Print and Embroidery workloads separate. Distinguish
historically scheduled volume from verified completed output, and observed
throughput from a proven capacity limit. Do not silently treat customer
deadlines as scheduled work dates or whole-invoice completion as evidence of
when each decoration method finished.
