---
name: AutoPrint alert cursor safety
description: Why observer progress requires reconciliation and atomic delivery
---
Alert scanning must reconcile behind the forward watermark, not rely solely on a fixed timestamp overlap.

**Why:** Audit timestamps precede transaction commit, so a late commit can arrive arbitrarily far behind a checkpoint. A fixed overlap cannot guarantee eventual notification.

**How to apply:** Keep bounded reconciliation cycles with a frozen upper boundary alongside the forward lanes, commit delivery and cursor progress atomically, and keep active fence/heartbeat checks independent of backlog. Preserve PostgreSQL timestamp precision in cursor serialization. None of these observer mechanisms may mutate print or source-job state.
