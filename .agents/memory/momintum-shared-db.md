---
name: moMINTum shared live DB rules
description: Hard rules for the hub's integration with the standalone moMINTum app's production database.
---

The hub embeds the moMINTum task app but shares the STANDALONE app's LIVE production Postgres (`MOMINTUM_DATABASE_URL`). Real team data — treat every write as production.

**Rules:**
- Member identity resolves BY EMAIL ONLY (case-insensitive, oldest row = lowest id wins; email is NOT unique in that schema and must not gain a unique index — the standalone app owns the schema).
- `members.clerk_user_id` stores the STANDALONE app's Clerk IDs (different tenant than the hub). NEVER write it from the hub — overwriting unlinks users from the standalone app.
- JIT-created members get NULL clerk_user_id; the standalone app links them on first sign-in there.

**Why:** Two Clerk tenants, one DB. Email is the only shared identity key.

**Lessons learned:**
- JIT-create raced under concurrent first requests (e2e produced duplicate member rows in prod). Since a unique index isn't allowed, the fix is `pg_advisory_xact_lock(hashtext('momintum:jit-member:'+email))` + re-select inside a transaction. Any future JIT-create against a schema you don't own needs the same pattern.
- The `MOMINTUM_DATABASE_URL` presence check runs at boot — toggling the secret requires an api-server restart (deliberate kill switch).
- Hub routes deliberately keep parity with the standalone app's gating (e.g. member PATCH is not admin-gated in either) — don't "fix" one side alone; both apps serve the same rows.
- E2E against this DB: single clearly-named test task + test member, then hard-delete via SQL (app deletes are soft). Check all 8 FK tables referencing members before deleting a member row.
