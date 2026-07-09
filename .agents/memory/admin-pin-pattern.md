---
name: Admin PIN gate pattern
description: How privileged actions (e.g. vendor-PO admin unlock) are gated in this unauthenticated internal API
---
# Admin PIN gate pattern

Rule: privileged destructive actions in the api-server are gated by an `ADMIN_PIN` env secret, compared with sha256 + `timingSafeEqual`, with a process-wide lockout (5 wrong attempts → 15 min 429). Routes must degrade gracefully (403 with a clear "add the ADMIN_PIN secret" message) when the secret is unset — never crash or silently allow.

**Why:** The internal API has no staff auth yet (deferred to pre-deployment). Tyler wanted vendor-submitted POs unlockable but not casually; architect flagged brute-force risk on a short PIN, hence the lockout. Constant-time compare avoids timing leaks.

**How to apply:** Reuse this pattern (unset-check → lockout-check → constant-time compare → reset counters on success) for any future PIN/secret-gated route until real staff auth lands. Guard order matters: validate body first, then unset-PIN 403, then lockout 429, then mismatch 403.
