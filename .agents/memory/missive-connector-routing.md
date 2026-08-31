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

## Multi-account sync (one token per teammate)

A Missive token only sees its own account's conversations — team-wide coverage
of personal mailboxes requires one token per person (`MISSIVE_API_TOKEN` +
`MISSIVE_API_TOKEN_<NAME>` secrets, auto-discovered by prefix). The sync loops
accounts in two phases: directory discovery across ALL usable accounts first
(so user→staff mappings visible only through a later account still apply to
threads hydrated under an earlier one), then per-account conversation
hydration. Per-account try/catch: one revoked token records a `partial` sync
status, never kills the pass. Dedupe across tokens is the
(provider, provider_thread_id) upsert + already-hydrated short-circuit.

**Traps:** every request inside a per-account helper must receive the account
token explicitly — a missed parameter silently falls back to the primary token
(this bug shipped once in the /v1/users pager). The single pacing queue stays
shared across all tokens. One-time deep backfills: temporarily raise
`initial_backfill_days` on the sync-state row, let a tick run, restore it —
the tick restarts safely mid-pass after a server restart.

## Write-path quirks (posts & drafts)

- Hub writes to Missive are allowlisted to `/v1/posts` and `/v1/drafts` only —
  keep it that way; everything else stays read-only.
- `POST /v1/posts` REQUIRES a `notification: {title, body}` object — omitting
  it returns 400 "Validation failed: notification is required" (hit live).
- `POST /v1/drafts`: `from_field` must be an address the token's own account
  can send as → creating a draft in a teammate's mailbox requires THAT
  teammate's token (`missiveAccountForMailbox` helper matches by label).
- Rule webhook payload shape is `{rule, conversation, message?, comment?}`
  with `message` at the TOP level (not nested under conversation). Signature:
  `X-Hook-Signature: sha256=<HMAC-hex of raw body>` — capture the raw body in
  the express.json verify hook or verification is impossible.