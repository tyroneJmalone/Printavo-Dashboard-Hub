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

## Shippo billing errors

Shippo can return HTTP 401 for a missing payment method, not just invalid credentials.

**Why:** A connected account's live tracking request returned an explicit billing-required response. Reconnecting would not fix that cause.

**How to apply:** Inspect and safely classify the response body before recommending reconnection. Surface billing guidance and pause account-blocked batches rather than repeating the same failed request for every package.