---
name: drizzle-kit push ignores partial-index predicate changes
description: drizzle-kit push does not diff a partial index's WHERE clause; changing the predicate needs a manual DROP INDEX then push
---

# Rule
`drizzle-kit push` matches indexes by name + columns and does **NOT** compare a partial index's `WHERE` predicate. If you change only the `.where(sql\`...\`)` of a `uniqueIndex`/`index`, push reports "Changes applied" but leaves the OLD predicate live in Postgres.

**Why:** editing `vendor_orders_active_uq`'s predicate looked applied (push printed success) yet `pg_indexes.indexdef` still showed the old `WHERE`; the new predicate only landed after a manual drop + re-push.

**How to apply:** After editing a partial-index predicate, run `DROP INDEX IF EXISTS <name>;` then re-run the package's `push` (it recreates the index from the schema). ALWAYS verify with `select indexdef from pg_indexes where indexname='<name>'`. Dropping is safe when the table is empty / low traffic; otherwise recreate inside a transaction or accept a brief unguarded window.
