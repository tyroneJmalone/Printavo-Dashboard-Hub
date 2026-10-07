---
name: Decoration production reporting direction
description: Proposed Orders Report view of quantities, location counts, applications, and method-specific job averages.
---

The user wants to explore a decoration-locations statistic within Analyze →
Orders Report, functioning as a production log: invoice counts, decoration
methods, quantities, 1/2/3/etc. locations, and quantities multiplied by their
respective location counts to calculate total decoration applications per job.
Their example target is an embroidery summary showing average job quantity,
average item sale price, average locations, and average stitches per location.
This is a discussion of the approach, not yet approval to implement.

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
