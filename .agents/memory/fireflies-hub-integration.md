---
name: Fireflies Hub integration
description: Durable access and ownership constraints for the deferred Fireflies meeting workspace.
---

The full discovery and phased plan lives in `docs/fireflies-hub-integration-plan.md`.

The current Fireflies account is Business with Team Admin access. Do not assume one API key can see every front-end employee's private meetings; run a read-only visibility audit before selecting a central, shared-channel, per-user, or Enterprise access model.

**Why:** Fireflies documents team-wide privacy bypass and team-wide webhook administration as Enterprise Super Admin capabilities, while the desired Hub experience spans several employees' meetings.

**How to apply:** Start any future Fireflies work with the Phase 0 audit in the plan. Keep meeting data and cross-product links in Hub-owned tables, never in synced Printavo rows or standalone-owned moMINTum tables. Keep credentials server-side and obtain them through the secure integration/secrets flow.