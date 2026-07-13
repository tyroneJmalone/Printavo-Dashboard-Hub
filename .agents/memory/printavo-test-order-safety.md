---
name: Printavo test-order safety
description: Which order may be used for real-write testing and why status changes are dangerous
---

**Rule:** Real-write testing against Printavo uses order **#18371 ONLY**. Never use #19004 again. If a different order is needed, ask Tyler first — never pick one unilaterally.

**Why:** Printavo has account-level automations that email customers on status changes. Testing on #19004 (July 2026) moved it through statuses and fired multiple emails to a real customer. Status changes are customer-visible side effects, not internal state.

**How to apply:** Before any test that changes an order's status (status-jobs, auto-print advance, etc.), confirm the target is #18371. Assume ANY status change on ANY order can trigger customer-facing messages. Caveat: #18371 is older than the 12-month sync window (local pv_orders starts ~#18907), so it is not in Postgres — Hub features that read from Postgres cannot see it without a targeted sync or Tyler choosing an alternative.
