---
name: Replit edge proxy kills long HTTP requests
description: Held-open HTTP responses through the dev/preview proxy die at ~48s — long server operations must be fire-and-forget with status polling
---

# Rule
Any server endpoint whose work can exceed ~45 seconds must NOT hold the HTTP response open. Return immediately (optionally after a short grace race so instant guard/no-op results still return synchronously) and let the client poll a status endpoint until the background job leaves its "running" state.

**Why:** Verified empirically July 2026 — the Replit edge proxy drops held-open responses at ~48s ("Unexpected end of JSON input" client-side at 48.5s), while real Printavo incremental polls take 130-380s. A synchronous design cannot work no matter the server timeout settings.

**How to apply:** Pattern used by the Hub's "Sync now" button: POST races the real work against a ~1.5s grace timer — fast guard results (busy / not configured / instant failure) return their true result; otherwise respond `{started}` instantly, keep the promise running detached (all errors captured into the job's DB row, never rejecting), and have the client watch the status endpoint every few seconds with a deadline. Reuse this for any future long job (seeds, vendor submissions, bulk pushes).

# Related gotcha
Background/detached shell processes (nohup/setsid) are frozen once a bash tool call ends — they can't be used to observe long jobs either. Poll via repeated short commands or the status endpoint instead.
