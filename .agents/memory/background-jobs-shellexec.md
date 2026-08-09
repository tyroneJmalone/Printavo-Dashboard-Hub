---
name: Long background jobs die with the shell
description: nohup/setsid processes started from shell commands do not survive; run long jobs inside the API server process. Plus drizzle array-param pitfall.
---

Processes launched from shell commands (`nohup ... &`, even `setsid ... & disown`) are killed when the command session ends — a multi-hour import silently died twice this way (empty log, orphaned run rows).

**Why:** the execution environment reaps the process group regardless of nohup/setsid.

**How to apply:** run long-lived work inside the API server process (boot-time bootstrap check + scheduler tick), and make the job resumable across workflow restarts (orphan-run cleanup + skip-recently-done). Foreground shell runs are fine only under ~5 min.

Harness note: esbuild-bundled harnesses with pino marked external must place the outfile INSIDE the package dir — ESM resolution is file-location based, so a /tmp outfile can't resolve externals (NODE_PATH is ignored by ESM).

Drizzle `sql` template pitfall: a JS array param (`${arr}::text[]` or `ANY(${arr})`) is NOT serialized as a Postgres array → "malformed array literal". Build `ARRAY[${sql.join(items.map(i=>sql`${i}`), sql`, `)}]::text[]` (or `'{}'::text[]` when empty).
