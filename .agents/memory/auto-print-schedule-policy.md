---
name: Auto-print schedule policy
description: Eastern-time and missed-run decisions for physical auto-print scheduling.
---
Daily auto-print times use Eastern civil time (America/New_York), not fixed UTC−5. Keep interval and daily scheduling as alternative modes.

**Why:** Staff expect a selected morning time to remain the same local time throughout the year.

Missed daily times are skipped rather than caught up after downtime or a busy run; nonexistent spring-forward times are skipped, and repeated fall-back times must not print twice.

**Why:** Catch-up can unexpectedly trigger physical printing when a server restarts or settings change. Multiple selected times within the repeated fall-back hour require deduplication across the whole sequence, not just equality with the last time.

**How to apply:** Preserve these semantics when changing scheduling or retry behavior; printer-delivery retries are separate from creating a new scheduled run.

Browser-startup recovery may retry before any PrintNode submission, but that does not authorize retrying an ambiguous printer submission or automatically replaying a missed batch.

**Why:** A startup failure cannot have printed a document; a lost response from PrintNode may already represent an accepted physical print. Treating these failures alike risks duplicate paperwork.

**How to apply:** Keep startup retries isolated from delivery retries. Failed-before-print history can support a new eligibility-checked run; do not describe that as a durable frozen-batch queue.

Automatic recovery must happen within the original batch, with at most three
total logical workorder attempts, not three additional retries. Manual requeue
is deliberately deferred.

**Why:** The user needs workorders together with their production batch rather
than recovered in a later batch; printing and subsequent status changes are
operationally coupled.

**How to apply:** Share the attempt budget across preparation and delivery.
Do not introduce an independent retry budget for each phase or automatically
resend uncertain printer submissions. Exhaust safe retries before deciding the
terminal outcome used for status routing.