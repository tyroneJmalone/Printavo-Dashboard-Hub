---
name: Shipment tracking billing and evidence
description: Why Shippo connection is separate from paid tracking approval, and why known shipments do not establish whole-order delivery.
---

Connecting Shippo does not by itself authorize billable external-shipment tracking. Preserve the separate explicit fee opt-in; use mocked tracking responses for verification.

**Why:** The user connected Shippo after we promised not to initiate paid tracking until pricing was confirmed. Shippo publishes external tracking usage fees; even read-only carrier requests should not be treated as free test calls.

**How to apply:** Do not enable tracking as setup housekeeping or during tests. Keep costs visible at activation.

Delivery evidence belongs to known packages, not the entire PO.

**Why:** Vendors can report split shipments later. All current tracking numbers being delivered does not prove every ordered line has shipped.

**How to apply:** Preserve “known shipments” wording unless package/quantity coverage is positively reconciled.

The user explicitly changed the refresh policy: stop checks when Vendor Status is Complete OR all known shipments are delivered, including the Refresh batch and background checks.

**Why:** Refresh checked all 19 POs when only one still needed attention. This supersedes the previous bounded discovery after delivery.

**How to apply:** Exclude terminal POs before counting/processing the batch. Empty shipment lists and mixed Complete/open vendor statuses are not terminal. Stopping discovery does not certify full ordered-quantity delivery.

## Shippo billing errors

Shippo can return HTTP 401 for a missing payment method, not just invalid credentials.

**Why:** A connected account's live tracking request returned an explicit billing-required response. Reconnecting would not fix that cause.

**How to apply:** Inspect and safely classify the response body before recommending reconnection. Surface billing guidance and pause account-blocked batches rather than repeating the same failed request for every package.

## Tracking without Hub purchasing adoption

The user said the team has not fully committed to Hub Purchasing and still purchases through another process. External-order tracking is a deferred idea, not authorization to implement it or change their purchasing process.

**Why:** They want to consider using Order Tracking independently of where orders are placed and explicitly asked to log the discussion for later.

**How to apply:** Revisit the full October 4, 2026 discussion in `docs/insights-log.md` before scoping work. It preserves targeted PO lookup versus account-history discovery, unverified vendor API visibility, and the recommendation—not an approved decision—to distinguish outside orders from Hub submissions.

The user has now requested a plan for outside-Hub PO tracking, with separate
expandable sections for Hub-submitted and externally placed POs.

**Why:** Tracking should support their existing purchasing process while making
the two PO sources distinct. This approves planning, not implementation.

**How to apply:** Preserve both sections in the proposed interface; confirm
vendor API visibility before promising external-order discovery.