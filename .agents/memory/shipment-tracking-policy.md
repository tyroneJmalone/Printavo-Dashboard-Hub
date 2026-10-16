External PO display must distinguish placement dates from status activity and
shipment dates. SanMar's currently integrated tracking services expose shipment
origins but not a reliable order-placement date; do not relabel either date as
the order date. Explicit read-only detail refreshes may enrich completed orders,
while routine active-order refreshes should still skip them.

**Why:** The user needs warehouses, order dates, and working invoice links in
outside-Hub tracking without restoring unnecessary completed-order polling.

**How to apply:** Match complete Printavo PO references or exact invoice numbers;
never expand abbreviated slash-separated PO numbers into guessed invoice IDs.
Use the internal Printavo ID for admin links and leave unavailable dates explicit.
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
the two PO sources distinct. The user subsequently authorized proceeding with
vendor visibility checks and implementation once visibility is confirmed.

**How to apply:** Preserve both sections in the proposed interface; confirm
vendor API visibility before promising external-order discovery.

Keep the vendor lookup reference separate from the Printavo display PO reference.

**Why:** The user's external-order examples included differing vendor and Printavo
PO numbers; silently replacing one with the other would make tracking unreliable.

**How to apply:** Preserve the exact reference used for vendor lookup and any
separately supplied Printavo reference or invoice links. No-match responses do
not prove that the purchase does not exist or that external orders are unsupported.

External-order API visibility has been verified for both SanMar and S&S using
user-supplied purchases placed outside Hub. This establishes targeted lookup
support, not automatic discovery of every historical PO.

**Why:** SanMar returned status and shipment data for an exact slash-containing
customer PO. S&S rejected a slash-containing PO in its encoded path with HTTP
404, but lookup by its vendor order number returned the matching customer PO,
warehouse, shipment tracking, and vendor-reported delivery status.

**How to apply:** Preserve punctuation in customer POs. External tracking needs
an explicit vendor order-number lookup option, separate from the customer PO
and Printavo reference. Do not strip slashes or treat an HTTP 404 for an encoded
reference as proof the order is absent. Label S&S delivery evidence as vendor
reported; obtaining it does not require paid carrier tracking.

Recent-history discovery has different date semantics by vendor.

**Why:** Live read-only verification confirmed SanMar PromoStandards queryType 3
returns orders with status updates since statusTimeStamp, without order creation
dates. S&S GET orders with All=True returns recent history with orderDate
(documented retention: last three months).

**How to apply:** Do not label SanMar's last-update results as orders placed
within a date range. Preserve the date basis in the import UI and confirm scope
if the requested history window requires creation dates. Deduplicate against
Hub submissions before importing; discovery counts are not non-Hub PO counts.

The user approved a seven-day import using S&S order-placement dates and SanMar
status-update dates, including SanMar orders originally placed earlier.

**Why:** Recently updated older purchases still matter for incoming-goods tracking.

**How to apply:** Label the two date bases explicitly. Never imply the SanMar
creation date is known. Imported external records are tracking-only, not Hub
submissions, and must never release submission locks, change Printavo statuses,
trigger AutoPrint, or activate paid carrier tracking.

SanMar history may contain the literal customer PO “NOT AVAILABLE” while still
providing a valid factory sales-order number.

**Why:** A verified discovery result could not be fetched by that placeholder PO;
the read-only sales-order lookup returned its actual shipment details.

**How to apply:** Use queryType 2 for both status and shipment lookup when the PO
is unavailable, retaining the factory order as the tracking identity rather
than merging unrelated missing-PO records.