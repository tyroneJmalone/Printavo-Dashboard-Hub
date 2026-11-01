# Future enhancement: Google review requests from Hub

## Status
Planning document, October 30, 2026. The user requested a future-enhancement
plan, not implementation or live sending. No provider, eligibility criteria,
timing, or automation settings have been approved. Recommendations below are
proposals for discussion.

This expands the earlier review-request discussion in
`docs/recent-operations-ideas.md`; it does not silently replace earlier safeguards.

## Current process and desired outcome
The team currently scans the production calendar for recently completed orders,
compiles customer order details and contact information, enters emails into a
spreadsheet, uploads that spreadsheet to Constant Contact, and sends a campaign
using an existing email template.

The user envisions a Hub queue presenting orders that meet defined criteria,
with a user approving review-request sends. Unattended sending is a future goal,
not the initial release.

Replace repetitive discovery and spreadsheet preparation first. Keep human
review of recipients and timing until the suggested queue is demonstrably
reliable. Retain a visible explanation of why each item qualifies or is held.

## Recommended queue design
Orders are the eligibility evidence, but recipients should be the sending unit.
Group multiple eligible orders for the same recipient into one request rather
than making each order independently sendable. Show all related invoice links.

Suggested views:
- Ready for approval.
- Held / needs information.
- Scheduled / sending.
- Sent / delivery history.
- Already reviewed / excluded.
- Failed / delivery uncertain.

Suggested row contents:
- Customer/company, contact name, email, and relevant invoice numbers.
- Order nickname/description and enough context to personalize the request.
- Current status, completion/fulfillment evidence, date and its source.
- Eligibility reason, missing information, and suppression warnings.
- Last request, past campaign history, known-reviewer state, and any deferral.
- Proposed recipient, send timing, and staff approval state.

Filters: date range, customer, owner, status, eligibility reason and request
state. Actions: preview, correct recipient, approve one or a batch, defer until a
date, exclude with a reason, and mark already reviewed. Record who approved or
changed a decision and when. Apply role permissions to approvals and settings.

## Eligibility: define business rules before building
Use confirmed fulfillment/pickup/delivery where reliable, rather than assuming
production completion means the customer has received the order.
An old order's production due date is not evidence of actual fulfillment.

Proposed configurable rules, with final values to be chosen:
- Eligible invoice statuses, plus explicit excluded statuses/categories.
- Required fulfillment signal, or a staff-confirmed alternative if unavailable.
- A delay after fulfillment; illustrative starting point is 3–7 days, not an
  approved value.
- A persistent earliest eligible date/lookback limit to prevent the first scan
  from exposing the whole historical customer base to sends.
- A valid, appropriate recipient with permission under the chosen sending
  policy; possessing an address alone is not sufficient evidence of consent.
- No qualifying prior request or other suppression.

Review explicit handling of quotes, cancelled/deleted orders, internal/test
orders, MERCH orders, partial deliveries, multiple shipments, reopened orders,
rework and multiple contacts. Do not assume which MERCH statuses should qualify.
One delivered package does not prove complete order delivery.

Hub's synchronized change history may help establish when a status was observed
to change. It is not necessarily Printavo's original action timestamp, nor a
guaranteed actual fulfillment timestamp. Preserve source/provenance and route
missing or ambiguous dates to staff review.

Recheck live/recent source evidence and suppression at approval and immediately
before sending. A stale queue item must not bypass a changed status or opt-out.
Do not send when required upstream data is unavailable or stale.

## Recipient selection and duplicate prevention
Recommend initially one request per known person, not one per order, and no
automatic reminders. A future repeat-request interval requires explicit policy.
The billing contact may not be the person who experienced the service; provide
a staff-confirmed alternative and retain the correction's provenance.

Normalize addresses conservatively, deduplicate across orders/customer records,
and check the entire selected batch. Do not rewrite addresses using guessed
provider alias rules. Multiple addresses for one person need confirmed identity
linking; do not claim perfect person-level deduplication.

Import existing Constant Contact campaign/request history, unsubscribe records,
bounces and known reviewers before activation. Missing past history must be
visible, not interpreted as proof that somebody was never asked.

Suppress opt-outs, complaints to the email provider, unusable/bounced addresses,
and known reviewers regardless of their rating. Record exclusions and their
source. Staff must not choose recipients based on predicted positive ratings.
Temporary operational holds must follow neutral rules, not become review gating.

## Approval, sending and reliability
Each approval should bind the selected recipient, orders, template version and
content. Changes after approval require review again.
Batch approval sends separate personalized messages, never a shared recipient
list exposing customer addresses.

Recommended states: candidate, held, approved, scheduled, sending, accepted by
provider, delivered, bounced, failed, uncertain, suppressed. Provider acceptance
is not proof of inbox delivery; delivery events are not proof of reading.

Persist a durable send claim and stable duplicate-prevention identity before
calling the provider. Concurrent staff approvals, repeated clicks, restarts and
scheduled runs must not create duplicate sends.
Use provider idempotency where supported; an ambiguous response stays held for
reconciliation rather than blind retry. Only definitely safe failures retry.
Record provider message/campaign identifiers and reconcile delivery feedback.

Show the email preview and a final recipient count before approving a batch.
Provide a global pause, batch cancellation before sending, and an audit history.
A pause cannot retract email already accepted by the provider.

## Delivery options: choose deliberately
### Option A — Hub queue with Constant Contact export
Lowest-disruption transition: Hub builds the reviewed recipient list and exports
the required fields for the existing campaign process. Staff still upload/send
in Constant Contact.

Exported is NOT sent. Track exported/reserved batches separately and reconcile
the actual campaign recipients and send date. Keep unresolved exports out of
new batches until confirmed sent or released. This removes calendar/spreadsheet
assembly, but does not yet provide true send-from-Hub execution.

### Option B — Hub-controlled Constant Contact sending
Potentially retain the established provider, template and suppression history
while initiating the campaign from Hub.
Verify API/account access, campaign creation/send restrictions, personalization,
template reuse, recipient selection, consent, opt-outs and delivery-event
availability before promising this path. No connection or capability is
assumed from the fact that the team already uses Constant Contact manually.

### Option C — Hub sends using an approved alternative
Evaluate the existing Resend setup as an alternative, provided its account,
sender and sending policy support these review-request emails. Missive was
previously discussed as another option if shared-inbox handling is central;
actual campaign/sending suitability requires verification.

Any migration needs the existing suppression/history data, appropriate unsubscribe
handling, authenticated sender/reply-to configuration and a maintained template.
Do not assume review requests are exempt from marketing-email requirements.

Recommendation: preserve Constant Contact as the first delivery option to
evaluate. Use export as an optional bridge if it provides immediate value;
choose one direct-send path before building the complete execution phase.

## Message, review destination and reviewer identity
Use a clean Mint-branded message with a recognizable sender, monitored reply
address, short personalized wording, one direct link to the correct Google
review form, and the required sender/opt-out information.
Verify the actual business/location review link; do not invent it.

Illustrative copy, not a final approved template:

> Subject: Thanks for your recent order, Sarah
>
> Hi Sarah,
> Thanks for working with Mint Printworks on your team shirts. If you have a
> moment, we'd appreciate an honest Google review of your experience.
>
> Leave a Google review
>
> Thanks, the Mint Printworks team

Avoid an extra landing page unless necessary. Small opt-out or already-reviewed
confirmation pages are reasonable. A QR code on pickup/packing materials could
reuse the same review destination later.
No incentives, predetermined positive wording, or rating-first funnels that
send only satisfied customers to Google. Recheck current Google and provider
requirements before launch.

A direct review link does not require importing Google reviews. Later review
monitoring may require Google Business Profile API eligibility and permissions.
Do not assume reviews can be matched to customer emails: display-name matches
are not verified identity. Clicking a link does not prove a review was posted.
Allow manual known-reviewer identification with an optional review link.
Self-reported already-reviewed requests can suppress further email while
remaining labeled self-reported rather than independently verified.

## Future unattended automation
Use the same queue, suppression rules, delivery safeguards and audit trail.
Start with automatic discovery but staff-approved sends. Later enable automatic
approval only for a defined, well-tested eligibility group.

Configurable controls should include schedule/timezone, post-fulfillment delay,
daily/batch limits, earliest eligible date, recipient policy and a pause switch.
Turning automation on must not automatically release the historical backlog;
require a deliberate cutoff and preview of the population.
Exceptions continue to require staff review. Do not introduce reminders by
default. Keep development tests restricted to designated internal addresses;
copied production data must never trigger campaigns from development.

## Reports and success measures
Track candidates, ready/held counts, approved/sent/delivered requests, bounces,
opt-outs, duplicates prevented, uncertain deliveries and time saved.
Provide per-customer request history and staff/date filters for audit review.
Clicks and opens, if available, are imperfect signals and not reviews.
Report confirmed or self-reported reviews with their evidence; do not claim an
exact conversion rate from name matches or the total increase in Google reviews.

## Proposed rollout and acceptance checks
1. Define real status/fulfillment rules; audit date/contact coverage; identify the
   sender, Google review link, template, historical sends and suppression sources.
2. Build a read-only candidate queue and compare it against staff's manual list.
   Explain every discrepancy. No email execution at this stage.
3. Add preview, corrections, deferral, exclusion, approval and durable history.
   Introduce export only if the team chooses the transitional workflow.
4. Integrate the chosen direct-send provider and delivery reconciliation.
   Test with internal recipients, then a small explicitly approved live batch.
5. Review results and only then offer controlled unattended sending.

Acceptance tests must include duplicate orders/addresses, simultaneous approvals,
recipient edits after approval, imported prior sends, opt-outs between approval
and send, stale/missing fulfillment evidence, partial delivery, reopened orders,
provider timeout after possible acceptance, restarts, batch partial failure,
pause behavior and suppression of old backlog on first activation.

## Companion feature: Google Reviews monitoring and replies

Google's Business Profile API supports listing reviews for managed locations,
reading ratings, comments, public reviewer information, creation/update times
and existing business replies. It supports publishing/updating a business reply
and deleting that reply, but not deleting a customer's review.

Proposed Hub layout: separate **Requests** and **Reviews & Replies** views.
Constant Contact handles outbound requests; Google supplies reviews and publishes
staff-approved responses. Begin with configurable scheduled review checks,
new/unanswered filters, rating/date filters, and alerts. Real-time notifications
for new or updated reviews are possible through Google's Cloud Pub/Sub, but add
setup and operational complexity that may not be necessary at Mint's volume.

Staff should review and explicitly approve public replies. Optional AI may draft
responses, never publish by default. Record the approving/publishing user and
time; re-read the review and existing reply before publishing to avoid overwriting
another staff member's work. Handle edits, removals, failed syncs and uncertain
publication results explicitly. Public replies must not reveal private order or
customer details. Evaluate Google's API storage/retention policies before building.

Google does not provide the reviewer's customer email address or Printavo invoice
number. A public-name match is only a suggestion, not proof of identity or campaign
conversion. Require staff confirmation for customer links. Clicks from Constant
Contact do not prove that a review was submitted. Do not use sentiment to decide
who is invited to review.

Access requires an approved Google Cloud project and OAuth authorization from an
owner/manager of Mint's Business Profile. Google's current prerequisites include
a verified profile active for at least 60 days and a business website. Existing
Drive/Gmail access does not establish Business Profile authorization. Account
approval, scopes and location access have not been verified.

Documentation reviewed:
- https://developers.google.com/my-business/content/review-data
- https://developers.google.com/my-business/content/prereqs
- https://developers.google.com/my-business/content/notification-setup

This is a deferred companion proposal, not authorization to connect accounts,
enable monitoring or publish replies.

## Decisions to return to
Which statuses signify fulfillment and which are excluded? Which timestamp is
trustworthy? What delay/lookback is appropriate? Who is the right contact?
One request per person indefinitely or a later repeat policy? Where is historical
Constant Contact send/suppression data available? Retain Constant Contact or
change provider? Who can approve? What limits/timezone and retention policy
apply? No answers are assumed by this document.
