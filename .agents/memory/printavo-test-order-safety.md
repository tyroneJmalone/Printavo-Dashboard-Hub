---
name: Printavo test-order safety
description: Which order may be used for real-write testing and why status changes are dangerous
---

**Rule:** Real-write testing against Printavo uses order **#22251 ONLY** ("TEST DO NOT ORDER", printavoId 23448572, synced in pv_orders). Never use #19004 again. If a different order is needed, ask Tyler first — never pick one unilaterally.

**Why:** Printavo has account-level automations that email customers on status changes. Testing on #19004 (July 2026) moved it through statuses and fired multiple emails to a real customer. Status changes are customer-visible side effects, not internal state. Tyler then designated #22251 (a purpose-built test order). #18371 was considered but is older than the 12-month sync window, so Postgres-reading features can't see it.

**How to apply:** Before any test that changes an order's status (status-jobs, auto-print advance, etc.), confirm the target is #22251. Assume ANY status change on ANY order can trigger customer-facing messages. #22251's home status is "Admin Don't Sync" (280019) — return it there after tests.
