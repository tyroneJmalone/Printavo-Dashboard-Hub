---
name: Drizzle raw-SQL array params
description: How to pass a JS array as a single Postgres array parameter in drizzle sql`` templates (ANY() queries)
---

# Drizzle raw-SQL array params

**Rule:** In a drizzle `sql\`\`` template, interpolating a JS array (`sql\`x = ANY(${arr})\``) expands it into a tuple of individual params `($1, $2, $3)`, and Postgres fails with `op ANY/ALL (array) requires array on right side`. Wrap the array with `sql.param(arr)` to send it as ONE array-typed parameter: `sql\`x = ANY(${sql.param(arr)})\``.

**Why:** Hit this in the Reports module — all `= ANY(ids)` child-table loads and the payments `typename = ANY(types)` filter 500'd until fixed. Verified `sql.param` works on drizzle-orm 0.45 + node-postgres.

**How to apply:** Any raw `sql\`\`` fragment that passes a list into `ANY()`, `= ALL()`, or an array-typed parameter. Drizzle's query-builder `inArray()` is unaffected.
