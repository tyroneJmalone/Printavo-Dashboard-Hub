---
name: Drizzle push misses index predicate changes
description: drizzle-kit push does not detect adding/changing a WHERE clause on an existing index; recreate manually and verify pg_indexes.
---

Changing only the WHERE predicate of an existing index in the Drizzle schema reports "Changes applied" on push but leaves the old index definition in the database (column/FK changes in the same push DO apply). The mismatch surfaces later as unexpected constraint behavior.

**Why:** predicate-only index changes are not detected by the push diff, so schema and database silently diverge.

**How to apply:** after any partial-index predicate change, verify the live definition in pg_indexes and recreate the index to match the schema if it is stale.
