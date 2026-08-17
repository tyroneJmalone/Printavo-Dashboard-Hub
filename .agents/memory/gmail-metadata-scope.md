---
name: Gmail scope choice for metadata-only sync
description: gmail.metadata scope forbids the q= search param; use gmail.readonly with format=metadata instead
---

The rule: for the email-activity sync (and any Gmail metadata work), the domain-wide-delegation scope must be `https://www.googleapis.com/auth/gmail.readonly`, NOT `gmail.metadata` — even though only metadata is read.

**Why:** the `gmail.metadata` scope rejects `messages.list` calls that use the `q` parameter (needed for `newer_than:` backfill windows). Privacy is preserved instead by always requesting `format=metadata`, which never returns bodies.

**How to apply:** keep the setup walkthrough, the `verifyMailbox` check, and any Admin-console instructions pointing at `gmail.readonly`; never "tighten" it to gmail.metadata or backfill breaks. Module stays dormant until the `GOOGLE_SERVICE_ACCOUNT_JSON` secret exists.
