---
name: Database copy precedes publishing readiness
description: A failed publish can already have successfully replaced production data.
---

Check production row counts and the database-copy log before recommending another development-to-production overwrite after a failed publish.

**Why:** The managed copy completed successfully even though the subsequent VM readiness stage failed. Production already had the development records, and the previous app remained healthy.

**How to apply:** Treat database-copy success separately from overall publish success. If the copy succeeded, disable the overwrite option for retries so new live data is not replaced again. Do not infer that a failed publish rolled back the database copy.