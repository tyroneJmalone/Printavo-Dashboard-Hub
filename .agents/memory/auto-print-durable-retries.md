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

The requested admin-notification proposal must include alerts when AutoPrint
fails, not only when retries require manual review. This is proposed scope,
not a statement that notifications are enabled.

**Why:** The user explicitly expanded the manual-review notification idea to
include notification when failure occurs.

**How to apply:** Include an initial failure alert even if automatic retry is
still scheduled, and a distinct escalation when administrator review is needed.
