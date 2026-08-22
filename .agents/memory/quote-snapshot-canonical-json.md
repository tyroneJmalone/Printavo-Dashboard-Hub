---
name: Quote snapshot comparisons
description: Why trusted AI quote preflight snapshots require canonical object-key ordering.
---

Trusted quote data must be compared with recursively key-sorted JSON while preserving array order. Never compare a freshly constructed object to a PostgreSQL JSONB value with raw `JSON.stringify`.

**Why:** PostgreSQL JSONB reorders object keys. A just-saved quote draft and a freshly reverified draft can contain identical values but stringify differently, producing a false stale-data 409 immediately after save.

**How to apply:** Canonicalize object keys at every depth before safety comparisons. Continue treating array order and all scalar values as meaningful so genuine customer, product, cost, pricing, or decoration changes still block creation.