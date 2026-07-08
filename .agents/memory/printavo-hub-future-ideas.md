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
