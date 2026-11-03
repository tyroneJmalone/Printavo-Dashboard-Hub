---
name: AutoPrint current outcomes and summary emails
description: Approved twice-daily Eastern summaries and invoice status interpretation.
---

The user approved daily summary emails at 8 AM and 2 PM Eastern, after the paired
morning and midday printing batches and expected retries. Keep immediate failure
alerts separate from summaries. A summary must still be sent when outcomes remain
unresolved; pending retries are not successes.

**Why:** Staff need a concise outcome overview while dialing in AutoPrint, without
reading every historical attempt. Fixed summaries avoid overlapping emails for
closely scheduled batches.

**How to apply:** Use Eastern civil time across DST; don't backfill missed sends
on activation. Preserve a frozen per-slot payload and provider idempotency for
uncertain email acknowledgements. Never test by sending real mail without approval.

Invoice search should show the latest meaningful document outcomes plus active
correction holds, not simply the newest historical row. A routine duplicate skip
must not hide an accepted print; a downstream PrintNode error must override
submission success. Explain that success does not prove physical paper output.
