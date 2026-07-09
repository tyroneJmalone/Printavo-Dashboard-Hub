---
name: E2E test sessions restart all workflows
description: The e2e testing subagent bounces every workflow around its session boundaries — long background jobs get orphaned mid-test; don't misread as a code failure
---

# Rule
When an e2e test overlaps a long-running background job (e.g. a 2-6 minute sync), expect the job to be killed: e2e testing sessions were observed (twice, July 2026) restarting ALL workflows mid-test, orphaning in-flight sync runs which the server then marks "Orphaned: process restarted mid-run" on next boot.

**Why:** A first e2e run of the Hub's "Sync now" flow returned "unable" because the sync it triggered died at a workflow restart ~7 minutes into the session — the code was fine; a clean re-run passed.

**How to apply:** Before concluding a long-background-job feature is broken from an e2e failure, check the job table (`sync_runs.error`) and server boot timestamps in workflow logs. "Orphaned: process restarted mid-run" during a test window = environmental, re-run the test. Also: server-side orphan-marking on boot is essential so client watch loops surface a failure instead of spinning forever.
