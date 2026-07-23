---
name: Streaming download drain vs client disconnect
description: Node streaming responses (archiver ZIP, PassThrough) — drain awaits must race response close or handlers hang forever
---

**Rule:** In any Express handler that streams to `res` with backpressure (`await once(stream, "drain")`), the drain wait MUST race the response's `close` event: `await Promise.race([once(entry, "drain"), responseClosed])`, then bail if the client is gone.

**Why:** When the client disconnects mid-download, downstream consumers (e.g. archiver reading a PassThrough) simply stop consuming — `drain` never fires and the entry emits no `error`. The awaited promise parks forever: `finally` never runs, any module-level in-flight guard stays locked (permanent 409 until restart). Caught by code review on the backup export; per-loop `clientGone` checks cannot help because control is parked inside the await.

**How to apply:** Build one `responseClosed` promise per request from `res.on("close", ...)`, race every drain wait against it, and `break` when the client is gone so `finally` releases guards. Verify with: start download, kill curl after a few seconds, immediately run a second request — it must succeed, not 409.

Related archiver v8 note: it's ESM class-based — `import { ZipArchive } from "archiver"`, `new ZipArchive({ zlib: { level: 6 } })`; the old default-export `archiver(...)` API is gone.
