---
name: Hub-owned tables in the live moMINTum DB
description: Rule for adding hub features that need schema in the standalone moMINTum production database
---

**Rule:** When a hub feature needs new persistent state in the live moMINTum DB, add SEPARATE additive tables — never new columns on standalone-owned tables (`lists`, `tasks`, `members`, ...).

**Why:** The standalone moMINTum app manages that DB's schema with its own drizzle tooling. Unknown columns on its tables risk being flagged/dropped by its migrations; separate tables it never selects from are invisible to it. Existing hub-owned tables: `list_groups`, `list_group_memberships` (sidebar folders; membership table joins `groupId` into the hub's List DTO). The standalone app must never drop these.

**How to apply:** New hub-owned tables go in `lib/momintum-db/src/schema/` with FKs `onDelete: cascade` to standalone tables (so standalone-side deletes self-clean), DDL applied manually to the live DB (additive only — no drizzle push against prod). JIT seeding by the sync must only run on first creation, never re-assert state the user may have changed (e.g. don't re-nest lists a user ungrouped).
