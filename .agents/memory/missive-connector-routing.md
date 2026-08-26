---
name: Missive API transport
description: Managed connector routing defect and the approved direct API transport
---

The managed Missive connector routes documented API paths to the public
website instead of the JSON API host. Reauthorization does not repair this
server-side base URL.

The approved Hub transport uses a Missive API token stored only in Replit
Secrets and sends requests directly to the fixed public API origin. Requests
are paced, honor provider retry timing, skip already-current conversations, and
reject untracked-mailbox conversations before downloading full bodies.

**Why:** The managed route repeatedly returned HTML 404 responses, while the
direct API completed a live sync of messages, internal comments, and access
grants. Unpaced body hydration also exhausted Missive's request quota.

**How to apply:** Never expose or log the token. Keep the origin fixed, paths
limited to the versioned API, and fail closed on non-JSON responses. Preserve
rate-limit handling and incremental hydration in every Missive read path.