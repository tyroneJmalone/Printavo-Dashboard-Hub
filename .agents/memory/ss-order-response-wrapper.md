---
name: S&S order API response wrapper
description: Real S&S order endpoints wrap responses in { orders, lineErrors } — not the bare array the docs imply.
---

**Rule:** S&S Activewear order endpoints (POST /orders, and treat GET /orders/{po} the same defensively) return `{ "orders": [ ... ], "lineErrors": [ ... ] }` — an object wrapper, NOT a bare array of orders. Order fields are camelCase (`orderNumber`, `orderStatus`, `trackingNumber`, `shippingCarrier`, `shippingMethod`). Parse via an unwrap helper that accepts wrapper / bare array / single object.

**Why:** First live S&S order (2026-07-16, PO 22209 → S&S order 74469826) succeeded at the vendor but parsed zero order numbers because the code expected a bare array — the row landed in "unknown" and the anti-double-order PO lock was skipped until a manual refresh reconciled it. The docs/assumptions were wrong; the real response is the source of truth.

**How to apply:** Any new S&S order-related parsing must go through the shared unwrap logic in the S&S client lib rather than assuming response shape. If a submit ever reports "accepted but no order number" again, check the stored raw_response first — the number is usually in there, and the read-only refresh endpoint reconciles unknown→submitted safely.

Also: `lineErrors` exists in the wrapper (submits use rejectLineErrors=false, so partial fills report per-line errors there) — worth surfacing if partial-fill issues ever come up.
