---
name: Printavo connection rotation
description: Scope and security constraints for administrator-managed Printavo credentials.
---

Keep Hub-managed credential rotation separate from other integrated platforms and
the standalone Mint Bucks settings. Isolate development and published overrides.
Keep one shared Printavo request gate when credentials change.

**Why:** The user reports expiring Printavo tokens requiring manual replacement
across platforms. A Hub update must not corrupt standalone encrypted settings or
silently change the published connection from a development test.

**How to apply:** Encrypted overrides depend on the environment's SESSION_SECRET;
rotating that secret requires re-entering the saved Printavo token. Never fall
back silently to an old server token when a stored override cannot be decrypted.
The entered expiration is user-supplied metadata, not a verified provider date.
