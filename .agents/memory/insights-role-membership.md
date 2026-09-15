---
name: Insights role membership in production
description: PostgreSQL role membership can exist without permission to SET ROLE.
---

Check pg_auth_members.set_option when Ask AI reports permission denied to set role insights_ro; membership alone does not prove role switching is allowed.

**Why:** Production had an ADMIN membership with INHERIT=false and SET=false. The role already had the intended table SELECT grants, but the runtime could not enter it. Development behavior differed.

**How to apply:** Preserve the restricted role and read-only transaction. Production grants require a user-run repair, not an agent production write or a new startup migration. Diagnose Dashboard and Reports separately; those queries do not use this role.