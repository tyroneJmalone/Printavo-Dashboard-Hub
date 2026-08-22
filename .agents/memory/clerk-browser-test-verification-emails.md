---
name: Clerk browser-test verification emails
description: Prevent automated Printavo Hub browser checks from sending unexpected development verification codes.
---

Do not start an email-code Clerk sign-in merely to run an authenticated Printavo Hub browser check. Reuse an already authenticated test session when available; otherwise verify through the API/database or clearly warn before triggering an email.

**Why:** A programmatic browser-test login sent a real `[Development]` verification-code email branded as Printavo Dashboard Hub from `notifications@accounts.dev`, which looked like an unexplained account-security event.

**How to apply:** Prefer read-only server/data checks for small authenticated UI verifications. When browser auth is essential, use a non-email test-session mechanism that cannot send a code, and never claim Hub authentication cannot generate these emails—Clerk uses the app's name as the sender identity.