---
name: Missive connector routing
description: Known Replit connector behavior that blocks live Missive API verification
---

The installed Missive connector currently routes documented API paths to the
public `missiveapp.com` website instead of the JSON API host
`public.missiveapp.com`. Both sandbox connection calls and the application
connector SDK return HTML 404 pages, so this is routing—not an authentication
failure. Reauthorization does not repair it.

**Why:** Treating the HTML response as an empty API result could falsely mark a
sync successful and hide that correspondence and grants were never reconciled.

**How to apply:** Fail closed on HTML/non-JSON responses, keep the error visible,
and suppress frequent retries. Do not ask for or add a pasted-token fallback.
When platform routing is repaired, live-verify pagination, message bodies,
comments, mailbox attribution fields, users, and grant reconciliation before
declaring Missive synchronization operational.