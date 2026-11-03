---
name: PrintNode downstream monitoring
description: Accepted submissions need separate downstream evidence; no automatic resend.
---

The user approved Hub monitoring after PrintNode's own notification setup did
not work for them. Keep downstream observation separate from Hub's accepted
submission ledger. Error/expired jobs must not be changed to retryable failures.

**Why:** A successful PrintNode submission can later fail, but a later error or
an unavailable status check does not prove no paper printed. PrintNode `done`
only confirms delivery to the operating system spooler, not physical output.

**How to apply:** Use read-only PrintNode state histories, deduplicated admin
alerts, and current status in run logs. Never automatically reprint or change
Printavo. Keep monitoring outages distinct from job errors. Downstream alerts
must remain visible for accepted jobs and must not share email deduplication
keys with earlier pre-submission errors on the same job.
