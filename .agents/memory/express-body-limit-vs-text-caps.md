---
name: Express body limit vs app-level text caps
description: JSON endpoints that accept large pasted/uploaded text silently 413 before the route runs unless express.json limit is raised in lockstep.
---

**Rule:** Any endpoint that accepts a large text payload (pasted email, CSV file text, etc.) must keep the `express.json({ limit })` ahead of the app-level character cap. The hub's api-server now uses `300kb` because the Chipply parse-file route caps fileText at 200,000 chars.

**Why:** Express's default JSON body limit is 100 KB. The Chipply CSV upload advertised (client + server validation) a 200k-char cap, but any file between ~100 KB and 200 KB was rejected by the body parser with a 413 *before* the route handler ran — surfacing as a generic "Something went wrong" toast with nothing useful in route-level logs. Small sample files never hit it, so tests passed.

**How to apply:** When adding or widening any text/upload cap, check `app.ts` body-parser limits in the same change. A 413 with no route log line is the signature of this bug.
