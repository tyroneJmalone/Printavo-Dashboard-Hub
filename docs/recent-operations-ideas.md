# Operations and customer-growth ideas — detailed discussion record

Recorded: September 29, 2026. Reconstructed from the recent discussions to expand the original short backlog entries.

**All three ideas are deferred, not started. Logging is not authorization to implement, connect accounts, alter purchases/prints, or send emails.** Recommendations and phased options below are proposals, not approved requirements.

## 1. In-house inventory visibility in Purchasing

### User's problem and proposal

The team sometimes has products in stock but lacks a dependable way to pull available inventory before buying more. The user proposed linking a live Google Sheet to Purchasing so matching PO Queue lines are flagged.

### Recommended first phase

Use the sheet as a read-only inventory source, with one row per specific style, color and size, plus on-hand quantity and shelf/bin location. Match conservatively; approved naming translations may be needed, but similar colors or styles are not substitutes.

Example sheet:

| Style | Color | Size | On hand | Location |
|---|---|---|---:|---|
| PC54 | Black | XL | 24 | Shelf B2 |
| PC54 | Black | L | 12 | Shelf B2 |

The queue could display:

> In-house stock available: 24 of 36 needed. Shelf B2. Inventory checked 2 minutes ago.

Refresh periodically and provide manual refresh. Describe this as synchronized, not instantaneously live. Show stale/unavailable data explicitly; a failed sheet connection must not silently look like zero stock.

Initially leave vendor quantities unchanged. A matching sheet row does not establish that the items are usable, correctly counted or uncommitted. This first stage tests list quality, matching and whether the team uses the alerts.

### Reservation and pull workflow as a later phase

Distinguish “inventory exists” from “inventory is set aside for this order.”

Example: order needs 36 shirts; sheet says 24; staff confirms/reserves 20 usable shirts; purchasing shows **20 from inventory / 16 to purchase**.

Proposed workflow: **Review → Reserve → Confirm physically pulled → Purchase remainder**.

Main risk: two orders see the same stock and both rely on it. Hub reservations should be order-specific and record staff responsibility and pull state.

**Available to reserve = on hand − active reservations.**

Canceling/changing an order must release or review its reservations. Define exactly when/how the sheet's on-hand balance is reduced, so a reservation and physical pull cannot deduct stock twice or leave used stock available.

### Longer-term option and unresolved questions

Hub could eventually own inventory/reservations while the sheet becomes a count/import/export tool; a full inventory system is not necessary to begin.

Before planning, inspect whether the current sheet has style/color/size detail, how reliably shelf withdrawals are recorded, who maintains counts, and how reserved/pulled stock should affect on-hand quantities.

## 2. Warehouse and ordered-date notes on auto-printed work orders

### User's proposal

Show where each line item was ordered from and the date, next to its printed product status.

### Feasibility findings from read-only investigation

Auto-print currently renders the upstream Printavo work-order page through Chromium. It does not locally generate each product row. Hub saves PO snapshots containing Printavo line/order references and optional warehouse code/name, plus a PO-level vendor-submission timestamp. The current PDF path would need augmentation and reliable line-to-row matching.

Suggested display:

> Ordered · SanMar — [warehouse] · PO submitted 9/29/26

Place a compact note beside or beneath the status. Leave upstream Printavo product-status text unchanged.

### Essential distinctions and safeguards

- Use the actual stored PO vendor-submission timestamp, not PO creation, Printavo push or the date a person marked the product Ordered.
- A submission timestamp is not necessarily supplier acceptance or shipment confirmation.
- The date is PO-level; do not portray it as independent per-line confirmation.
- Show multiple purchases/warehouses separately, ideally with quantities.
- Warehouse is saved at whole-PO-line level; do not invent per-size allocations without evidence.
- Manual/external/older purchases may lack warehouse or submission information; show it unavailable rather than infer it.
- Exact matching matters when lines are duplicated, changed, replaced or split. Do not join on style name alone.
- The printed note reflects available evidence at render time. Later purchases cannot update paper already printed.
- Printing a saved Hub PO after the work order is not the same as submitting a vendor order and cannot supply a vendor-submission timestamp that did not exist when the work order was rendered.

### Possible approaches

Preferred: safely annotate the fetched work-order markup before PDF generation if exact row matching is reliable. An added purchasing page/overlay is an alternative if inline matching proves unsafe, though it is less aligned with the requested next-to-status placement.

Code-investigation pointers, to recheck when planning: API printQueue autoPrint engine/pdf rendering and workorder presentation; purchasing PO snapshots, vendor submission and PO push. These observations establish feasibility only; no printing changes were made.

## 3. Google review requests from Hub

### User's goal

Expanded execution plan: [Google review requests from Hub](google-review-request-plan.md),
recorded October 30, 2026 with the current Constant Contact workflow and proposed
approval queue. Deferred; no sending or implementation authorized.

Replace a manual review-request process with a Hub view of recently completed orders, allowing one or multiple requests by email. Start manually and later automate. Avoid repeated requests, especially to people who already reviewed.

### Proposed interface

Group eligible orders by recipient, not one independently sendable row per order. Prefer fulfilled/picked-up/delivered evidence to production completion, because finished work may not have reached the customer.

Tabs: **Ready to request / Requested / Reviewed / Excluded**.

Show contact/customer, relevant orders, fulfillment date and request status. Provide:
- Single/bulk selection and separate personalized emails to each recipient.
- Preview and recipient correction when the billing contact is not appropriate.
- Mark Already reviewed, Don't request or Remind me later.
- Request history on the customer profile.

### Duplicate prevention and suppression

Suggested default: one initial request per known person, not per order; no automatic reminders initially.

Deduplicate email addresses across records and selected orders. Recheck eligibility at sending time and guard against simultaneous staff sends. Record recipient, sender, time and related orders. Import past manual request history and known reviewers before the first batch.

Suppress known reviewers regardless of rating, opt-outs, email spam complaints and bounced addresses. A dissatisfied customer's service complaint should not become a mechanism for selectively soliciting only positive reviewers. Any temporary operational delay should use a neutral policy, not expected review sentiment.

People using multiple addresses may need identity linking or manual suppression; do not claim perfect person-level deduplication.

### The reviewer-identity limitation

Google's reviews API exposes reviewer display information, not their email address. Therefore:
- Staff can mark a known reviewer and optionally retain the review link.
- A future integration could import reviews and suggest contact matches for confirmation.
- A name match is not proof of identity.
- Clicking the Google link does not prove a review was submitted.
- An “Already reviewed” self-report can stop further requests without being labeled independently verified.

### Email and customer-facing pages

Recommend a clean Mint-branded email with logo, short personal message, real reply address and one prominent button directly to Google's review form. An extra landing page adds friction.

Illustrative copy:

> Subject: Thanks for your recent order, Sarah
>
> Hi Sarah,
> Thanks for working with Mint Printworks on your team shirts. If you have a moment, we'd appreciate an honest Google review of your experience.
>
> Leave a Google review
>
> Thanks,
> The Mint Printworks team

Provide an unobtrusive stop-review-requests option. Small branded pages could confirm opt-out or “already reviewed.” A QR code on packing/pickup materials could point to the same Google destination.

No incentives, predetermined positive wording, or rating-first pages that send only satisfied customers to Google. Invite honest feedback.

### Tools and rollout

- **Google direct review link:** simplest initial destination; no review-reading integration necessary.
- **Existing Resend setup:** first sending option to evaluate for branding and delivery/bounce handling.
- **Missive:** alternative if shared-inbox workflow is the priority; verify actual sending support/permissions.
- **Google Business Profile API:** later monitoring and staff-confirmed matching, subject to API/account access.
- **Dedicated review service:** consider if SMS, multi-location operations or broader review monitoring justify it. Do not assume it solves reviewer identity.

Stages: **Manual select/preview/send → Hub-suggested batches with staff approval → optional automatic send after a fulfillment delay**.

Automation should reuse suppression/history controls, provide daily limits and a pause switch. Sender setup, past request history, fulfillment signals and relevant consent/compliance requirements need review before implementation.

Sources: [Google review-request guidance](https://support.google.com/business/answer/7035772), [Google reviewer fields](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews#reviewer).