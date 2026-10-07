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
Do not multiply an entire invoice's quantity by all its imprints, or assume
multiple imprint entries necessarily mean distinct physical locations. Confirm
how staff enter imprints and where exact stitch counts live before committing
to those definitions. Distinguish recorded invoice workload from evidence of
actual completed production. Keep proposed calculations distinct from
user-approved decisions.
