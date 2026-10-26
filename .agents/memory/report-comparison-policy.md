---
name: Report comparison semantics
description: Calendar-period and evidence boundaries for last-year comparisons.
---

Last-year comparisons retain the same selected filters and date basis; only
the reporting period changes. Use calendar dates, not a 365-day offset.
Compare elapsed month/year periods through the equivalent prior-year date;
complete calendar months include the entire prior-year month, including its
leap day where applicable.

**Why:** The user approved same-month and year-over-year comparisons to make
like-for-like revenue, order-count and quantity comparisons, rather than
comparing a partial current period against a full historical period.

**How to apply:** Show both inclusive ranges and retain prior-only/new groups.
Zero prior values are unavailable percentage-change baselines, not infinite
growth. Status-based comparisons describe current recorded statuses, not
reconstructed historical status snapshots. Group shares use full filtered
period totals, not the sum of overlapping group counts.

Customer reporting uses the same whole-order inclusion rules as existing
Reports. Decoration selection identifies orders containing that category;
it does not allocate invoice totals to a single decoration method. Customer
spend/quantity/order-count ranges are a separate, aggregate-level filter.

**Why:** The user requested customer lists by period, decoration, dollar value,
quantity, and number of orders. Keeping these two filter levels explicit avoids
silently changing established report totals or implying category-only revenue.

**How to apply:** Label whole-order values and per-customer thresholds distinctly.
Keep quoted value distinguishable from invoiced value, and keep Chipply revenue
separate. Print/export scope must explicitly distinguish displayed pages from
all matching rows rather than presenting a partial page as a complete export.
