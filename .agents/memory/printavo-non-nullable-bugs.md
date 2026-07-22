---
name: Printavo non-nullable field bugs
description: Deleted records make "non-nullable" fields null; recovery differs by query shape (salvage vs re-query without field)
---

# Printavo declares fields non-nullable that CAN be null after deletions

Observed live (two separate incidents):
- `PurchaseOrder.vendor` — null after the vendor is deleted (order extras path).
- `PaymentRequest.requestedBy` — null after the requesting user is deleted (paymentRequests list).

**Why it matters:** any new query touching an association to a deletable record
(users, vendors, contacts…) can crash an entire sync run with
`Cannot return null for non-nullable field X.Y`.

**Recovery differs by query shape — verified live:**
- Single-object queries (e.g. order extras): partial data survives alongside the
  errors → salvage it when EVERY error message starts with
  "Cannot return null for non-nullable field".
- Top-level list/connection queries (e.g. `paymentRequests`): the ENTIRE
  response `data` nulls out — nothing to salvage. Only recovery is re-querying
  the same page WITHOUT the poisoned field (query builder takes an
  `omit…` option; crawl catches the error and retries degraded).

**How to apply:** when adding any new Printavo query that selects a nested
user/vendor/contact, decide upfront which recovery path applies and wire it in;
never let one deleted record fail a whole backup/sync cycle. Test error paths
can't be provoked on demand — the poisoned records are real data (e.g. a
payment request deep in the list), so probe live with a paging script if needed.
