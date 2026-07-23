---
name: Orval query-key invalidation
description: React Query invalidation must match orval's generated key prefixes ("/api/...") — hand-typed prefixes silently no-op.
---

**Rule:** When invalidating TanStack Query caches for orval-generated hooks, use the generated `get<Op>QueryKey()` helpers or a prefix that provably matches them. Generated keys start with the full request path **including `/api`** (e.g. `["/api/customers", params]`), not the OpenAPI route path.

**Why:** A directory page invalidated `["/customers"]` after a mutation — no error, no warning, the table just never refreshed. Typecheck and API harness tests all passed; only an end-to-end browser test caught it.

**How to apply:** After any mutation, either call the generated key helper for each affected query, or use a predicate: `qc.invalidateQueries({ predicate: q => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/<area>") })`. Verify the prefix by reading the generated `get*QueryKey` functions in `lib/api-client-react/src/generated/api.ts`. Also note distinct features share the `/api` root (e.g. `/api/mintbucks/customers`) — keep prefixes narrow enough to avoid cross-feature invalidation.
