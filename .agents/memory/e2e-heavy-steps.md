---
name: e2e test plans must avoid heavy big-table verification steps
description: Playwright testing notebook crashes (EXECUTION_TIMEOUT → "Notebook not found") on steps verifying large rendered tables.
---

**Rule:** Keep e2e test plans lean — never include a step that counts/verifies rows in a large rendered table (hundreds of rows). Verify the underlying query directly via psql/harness instead, and have the user eyeball the heavy view manually.
**Why:** Two consecutive `runTest` runs died at the same step verifying a ~295-row live-scan table: river service EXECUTION_TIMEOUT, then every subsequent notebook command returned "Notebook not found" (session unrecoverable, `restart: true` on code_execution needed before retrying). The identical plan minus that step passed first try.
**How to apply:** In test plans, assert presence of a few specific rows or skip heavy tabs entirely ("do NOT click X — heavy scan, out of scope"); pair with a direct DB timing check for the endpoint.
