# Live quote conversion verification

Checked 2026-10-16 UTC (October 15 Eastern), using read-only production queries.
No orders were created, converted, refreshed manually, or otherwise modified by
this verification. The staff member reported changing #23056 from Quote to
Print Complete.

## Result: reporting preserved, conversion evidence missing

Before the scheduled sync, #23056 was a quote with internal ID `24547639`,
customer ID `2055118`, and source creation timestamp
`2026-09-21T15:32:33.000Z` (September 21, 11:32:33 AM Eastern).

After the scheduled sync, the same row was an invoice with status
`🏁 PRINT - Complete`. Internal ID, visual number, customer ID, and source
creation timestamp were unchanged. A `status_change` event was observed at
`2026-10-16T03:32:16.083Z`. There was no `converted` event for this order.
The event timestamp is not used as a historical creation date.

Read-only execution of the relevant CTEs from
`artifacts/api-server/src/lib/hub/dashboardMetrics.ts` against production returned:

| Check | Result |
|---|---|
| Current invoice ID | 24547639 |
| Customer/visual identity | unchanged |
| Quotes Created cohort rows | 1 |
| Quote cohort date | 2026-09-21T15:32:33.000Z |
| Repeat Customer chronology date | 2026-09-21T15:32:33.000Z |
| Qualifying customer order number | 13 |
| Dated conversion evidence rows | 0 |
| Date estimated flag | true |

Thus this order remains in September, not October, for quote and repeat-order
allocation. It remains a repeat order, not a new logical order on conversion.
The dashboard activity query selects the current invoice ID and the frontend
passes that ID to PrintavoOrderLink; the link target does not change here.
Authenticated browser navigation was not tested. September activity is outside
the current recent-activity window; absence there is not loss of its cohort.

## Explanation and limitation

In `artifacts/api-server/src/lib/sync/upserts.ts`, an existing-ID update records
status changes but does not preserve versioned quote-conversion evidence.
The preservation branch runs only for newly inserted invoice IDs matched to
an existing quote. This live conversion exercised the existing-ID branch.

The date remained correct because Printavo retained the same source timestamp,
not because the intended conversion snapshot was saved. Dashboard SQL correctly
labels the fallback as estimated. This is a failed verification of snapshot
preservation, not a claim that the versioned-event path passed.

Follow-up should atomically retain original quote-date evidence for same-ID
classification changes, including quiet syncs, and cover both identity paths
with regressions. Do not manufacture production evidence from observation time
or change another order solely to test the fix.
