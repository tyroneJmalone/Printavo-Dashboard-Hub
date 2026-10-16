---
name: Dashboard performance constraints
description: Prefer per-query shared work over cross-request dashboard caches.
---

Prefer sharing aggregation inside the dashboard SQL before introducing a
cross-request cache.

**Why:** On a realistic mirror, repeated scans of materialized per-order
quantities dominated execution; indexes on underlying tables cannot solve
that repeated CTE work. A cache would additionally need coordinated invalidation
across conversion evidence, payments, customer history, order details and
Eastern midnight to preserve total/drilldown agreement.

**How to apply:** Use read-only repeated EXPLAIN measurements and compare old/new
results within the same snapshot. Do not treat a single runtime observation as
a regression or sacrifice original quote-date evidence for speed.
