---
name: Shipment tracking billing and evidence
description: Why Shippo connection is separate from paid tracking approval, and why known shipments do not establish whole-order delivery.
---

Connecting Shippo does not by itself authorize billable external-shipment tracking. Preserve the separate explicit fee opt-in; use mocked tracking responses for verification.

**Why:** The user connected Shippo after we promised not to initiate paid tracking until pricing was confirmed. Shippo publishes external tracking usage fees; even read-only carrier requests should not be treated as free test calls.

**How to apply:** Do not enable tracking as setup housekeeping or during tests. Keep costs visible at activation.

Delivery evidence belongs to known packages, not the entire PO.

**Why:** Vendors can report split shipments later. All current tracking numbers being delivered does not prove every ordered line has shipped.

**How to apply:** Preserve “known shipments” wording unless package/quantity coverage is positively reconciled; keep bounded vendor discovery after known packages are delivered.