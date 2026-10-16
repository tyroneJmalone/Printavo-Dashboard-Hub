# Dashboard query performance

Run from `artifacts/api-server` with the existing development database:

```sh
pnpm check:dashboard-performance 5 ../../generated-artifacts/dashboard-baseline
# After changing queries, use a DIFFERENT output directory:
pnpm check:dashboard-performance 5 ../../generated-artifacts/dashboard-candidate ../../generated-artifacts/dashboard-baseline
```

This bundles only the query modules, not the server/schedulers. It uses one
repeatable-read **read-only** transaction and a 60-second per-statement timeout.
It does not insert fixtures, create indexes, refresh statistics, or mutate the
mirror. No production connection is needed. Generated plans are ignored by Git
and publishing; they contain SQL and potentially business-sensitive plan values,
so do not upload them as public assets.

The runner records exact table sizes, existing indexes, SQL, and JSON
`EXPLAIN (ANALYZE, BUFFERS)` plans for the aggregate and all six drilldowns for
Today, YTD and LY. Each query gets one discarded warmup and 3–20 measured
samples (default 5), with median and nearest-rank p95. Five-sample p95 is just
the maximum, not a statistically robust tail estimate.

Supplying a baseline also compares full query results (including page order,
values, evidence metadata and nulls) against the saved SQL on the **same current
snapshot**, then fails if any median exceeds baseline × 1.25 + 25ms.
This is a diagnostic guard, not a universal latency SLO. Keep hardware, database
size/statistics, load and PostgreSQL settings comparable; inspect the recorded
sizes and plans before treating a failure as a regression. Run at growing mirror
sizes and repeat under comparable load. Do not overwrite the baseline directory
with candidate output. SQL from baseline files must be trusted.

For semantic edge cases, independently run:

```sh
DASHBOARD_PG_FIXTURE=1 pnpm test:dashboard-metrics
```

## Development mirror measurement

Measured on 2026-10-16: 19,123 orders, 28,048 events, 76,106 line items,
19,121 payments, 3,696 customers. Baseline: three measured samples after warmup;
candidate: five after warmup. All 19 same-snapshot result comparisons passed.

| Query | Before median | After median |
| --- | ---: | ---: |
| Aggregate | 3,158 ms | 1,117 ms |
| Total orders, YTD | 214 ms (initial pass) | 104 ms |
| Total revenue, YTD | 203 ms (initial pass) | 102 ms |
| Items decorated, YTD | 210 ms (initial pass) | 99 ms |
| Net payments, YTD | 210 ms (initial pass) | 132 ms |
| New customers, YTD | 195 ms (initial pass) | 4 ms |
| Repeat customer orders, YTD | 298 ms (initial pass) | 99 ms |

The aggregate candidate's measured range was 1,106–1,169 ms. These are warm
database execution times, not HTTP/browser latency or a production guarantee.

## Plan findings and decisions

- The method-average correlated subplan scanned materialized quantities 8,922
  times (~1.76 seconds). Joining the unique per-order quantities before expanding
  methods removes that repeated scan without changing incomplete-detail or
  overlapping-method rules.
- Repeat history ranking ran ten times, once per period. Materializing that
  shared ranking performs it once while preserving the entire historical
  population and original-date evidence.
- Drilldowns joined unrelated statistics, forcing payment and history work on
  invoice/customer pages. Reference only the requested statistic so PostgreSQL
  can prune unused CTEs; keep canonical population definitions shared.
- Existing order, customer, visual-ID, line-order, imprint-group, payment-date
  and event-type indexes are present. A new persistent index cannot index a
  materialized CTE; extra date/evidence indexes were not justified for the
  dominant observed cost. No schema changes or index migrations are required.
- Cross-request caching was deliberately avoided: invalidation spans orders,
  conversion evidence, statuses, payments, customers and details, plus Eastern
  midnight. It risks stale evidence and total/detail disagreement. These changes
  share aggregation within a query only; authorization and routes are untouched.
- Remaining aggregate cost includes historical status classification using
  repeated regex expressions (~410 ms in the baseline plan). This can be
  investigated separately, without relaxing the transition-evidence rules.
