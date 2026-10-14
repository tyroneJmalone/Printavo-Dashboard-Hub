---
name: Printavo timestamp offset variability
description: Repeated read-only invoice queries return equal instants with different timezone offsets, breaking raw-string fingerprints.
---

Printavo can alternate between UTC (`Z`), `-04:00`, and `-05:00` representations of the same instant across consecutive reads. Normalize known timestamp fields to an instant before comparing snapshots; do not treat a timezone-format difference as an invoice edit.

**Why:** Read-only repeated queries of two blocked MERCH invoices reproduced differences only in production due, created, and updated timestamps. Normalizing these timestamps made the detail snapshots identical; a simulated actual one-hour change still differed. The existing correction audit stores hashes rather than the compared snapshots, so this reproduction does not prove the exact historical mismatch for every blocked invoice.

**How to apply:** Preserve genuine instant changes, malformed-value safeguards, array order where meaningful, and invoice/category/status write fences. Do not broadly discard timestamp fields or normalize arbitrary description strings. Calendar-date display rules remain separate from instant comparison.
