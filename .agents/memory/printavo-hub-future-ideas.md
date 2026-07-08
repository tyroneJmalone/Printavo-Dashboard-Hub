---
name: Printavo Hub — parked future ideas
description: Feature ideas Tyler explicitly parked for after the Hub v1 build; check before finalizing Hub architecture so v1 keeps the doors open
---

# Custom internal notification rules (parked July 8, 2026 — "keep in mind", not build now)
Staff-defined rules that watch incoming orders/quotes and notify the right person on match. Tyler's examples:
- Sales manager notified when a quote > $5,000 is entered.
- Purchasing notified when a rush order is entered (due date within 7 days of creation date).

**Why:** came out of a team meeting; Tyler wants it remembered, explicitly not scheduled.

**How to apply:** when building Hub v1 sync, make each polling cycle emit change events (new order/quote, status change, field change) rather than only overwriting current state — the rules engine later just subscribes to those events with zero extra Printavo API cost. Delivery can reuse the Resend connector. Recorded in the assessment doc under "Future Ideas".

# Approved "down the road" features (Tyler picked these July 8, 2026)
1. **Order Activity Timeline** — per-order change history + shop-wide feed, built from sync change events (Printavo shows no history). Same plumbing as notification rules.
2. **Quote Aging Alerts (pipeline view)** — flag quotes unanswered past N days; pipeline-by-stage/age view for sales.
3. **Reorder Request → Draft Quote** — portal reorder auto-creates prefilled draft quote in Printavo; reuses proven quote-creation write path.

**How to apply:** all three depend on the change-event sync design above — one more reason v1 sync must emit events, not just overwrite state. Ideas pitched but NOT picked (don't build unprompted): Customer 360, global search, morning digest, vendor stock check at PO time.

# Status duration & frequency analytics (Tyler, July 8, 2026 — for "regimented pipeline monitoring")
- Time-in-status per order (avg per status, stuck-order flags) + status frequency/recurrence counts (e.g., artwork/proof revision loops = rework rate).
- **Why:** Tyler wants pipeline discipline metrics; Printavo exposes no status history, so this data only exists if the Hub records status-change events from day one.
- **How to apply:** derives entirely from the change-event sync (status_change events with timestamps); durations accurate to polling interval. Prioritize getting sync live early so history starts accumulating.
