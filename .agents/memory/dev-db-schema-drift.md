---
name: Dev DB schema drift after rollbacks
description: Dev database can silently lose merged-schema tables (checkpoint rollbacks restore the DB, not code); publish diffs the DEV DB into prod, so a missing dev table ships broken tooling to production.
---

# Dev DB schema drift after rollbacks

The rule: whenever a feature's API surface 500s or a "complete" feature's tables are absent, check `information_schema.tables` against `lib/db/src/schema` before debugging code — then re-run `pnpm --filter @workspace/db run push`.

**Why:** Found Aug 31, 2026: `voice_profiles` and `draft_pattern_events` were defined in the merged schema but missing from the dev DB (post-merge push script was correct — pnpm scope-less `--filter db` does match `@workspace/db` — so the likely cause is a checkpoint rollback restoring an older DB snapshot after the merge). Replit's Publish flow diffs the **dev** schema into production, so a dev-side gap would have shipped the drafting-pattern tooling broken to prod.

**How to apply:**
- Table data created in a task environment (or lost to a rollback) never comes back with the schema — e.g. the five distilled voice profiles were gone and must be regenerated from the Voice Profiles page (and regenerated again in production after go-live).
- Before any publish that a feature depends on, sanity-check its new tables exist in dev.
