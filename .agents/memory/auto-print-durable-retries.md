---
name: Auto-print durable retry boundaries
description: Recovery permission, lease fences, and safe retry semantics
---
Only failures known to occur before PrintNode submission may retry automatically.
An accepted PrintNode ID or an uncertain POST outcome must never be automatically resent.
Lease expiry after the submission fence requires reconciliation, not another send.

**Why:** A rendering 403 was previously treated as terminal and moved the order
out of its source status, preventing ordinary reruns. Network uncertainty after
a POST is different: the printer may already have received it.

**How to apply:** Preserve exact live identity/source-status checks on every
attempt and logical visual/order dedup across quote conversion. Recovery at a
different current status requires explicit operator approval; staging recovery
does not itself print or change Printavo. Production alone runs scheduled live
retries. Never use real print submissions or real status mutations in tests.

Keep daily-slot checks independent of retry batch duration. A preparatory
failure on an already-printed order must remain held unless source reentry
and changed-line eligibility were established.

**Why:** Waiting for slow retries can miss a no-catch-up daily slot, and
failed detail reads do not justify moving a previously accepted order to
the failure status.

**How to apply:** Test retries that cross a scheduled minute and exhausted
preparatory reads with a prior accepted print, including zero automatic retries.

Recovery must prepare the destination independently of the document fingerprint.

**Why:** Reviewing a new fingerprint does not prove that routing was refreshed;
legacy failures may have no destination and changed decoration may invalidate
the old one.

**How to apply:** Exercise recovery through actual preparation and post-acceptance
finalization, checking both missing destinations and changed decoration groups.

Admin notifications must include alerts when AutoPrint fails, not only when
retries require manual review.

**Why:** The user explicitly expanded the manual-review notification idea to
include notification when failure occurs.

**How to apply:** Include an initial failure alert even if automatic retry is
still scheduled, and a distinct escalation when administrator review is needed.

Workorder-page Printavo 403s use two bounded rounds: up to three attempts,
15 minutes after the first round is exhausted, then up to three final attempts.
Do not move to Print Error during the wait. Other temporary failures retain
their configured delays unless already inside this bounded recovery sequence.

**Why:** The user approved a delayed second round after observing three failed
403 attempts followed by successful prints of other workorders. This is not
proof that Printavo sleeps or that every 403 will resolve with time.

**How to apply:** Keep the cooldown and consumed budget durable across restarts
and normal discovery. Recheck live eligibility before each attempt. Only known
pre-submission failures qualify; uncertain acceptance must never resend.
Existing terminal failures need explicit review, not automatic historical replay.
Admin alerts must distinguish waiting for round two from final exhaustion.

Alert delivery is a separate, read-only observer of durable print audit records.
It must never trigger recovery, resends, or upstream status changes.

PrintNode acceptance is not delivery confirmation. The user reports rare jobs
accepted by PrintNode that subsequently error without printing.

**Why:** PrintNode's documented stable states include new, sent_to_client, done,
error, and expired. Even done means delivery to the operating-system print queue,
not proof of physical paper output.

**How to apply:** Future downstream monitoring can use print-job state webhooks
and GET /printjobs/{jobId}/states. Keep acceptance and downstream outcome separate;
alerts for downstream errors or overdue confirmation must not automatically resend.
This monitoring is a recommendation, not yet an approved implementation.

**Why:** Delivery failures must not roll back a printer-acceptance record or
turn an uncertain print into a second submission. Imported history should not
create a flood of alerts when the channel first starts.

**How to apply:** Preserve the production activation boundary and durable
per-job failure/review/uncertainty dedup keys. Acknowledgement is per admin,
not resolution. The initial channel is in-app only; email or push delivery
requires separate configuration and approval.

Run age alone must not be treated as interruption: a live worker can spend a
long time discovering or rendering orders. Use a persistent worker heartbeat
to distinguish a silent worker from an active long-running job, including
runs that have not created any document records yet.

**Why:** Waiting for the next AutoPrint run to reconcile interruptions leaves
administrators unaware of discovery-stage crashes. Heartbeat-loss alerts
must ask for review, never declare a document unprinted or authorize a resend.
