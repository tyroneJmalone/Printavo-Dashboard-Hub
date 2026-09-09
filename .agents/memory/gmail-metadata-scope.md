---
name: Gmail scope choice for metadata-only sync
description: gmail.metadata scope forbids the q= search param; use gmail.readonly with format=metadata instead
---

The rule: for the email-activity sync (and any Gmail metadata work), the domain-wide-delegation scope must be `https://www.googleapis.com/auth/gmail.readonly`, NOT `gmail.metadata`. Scheduled sync must remain metadata-only. Staff-requested body previews may fetch one body live after mailbox authorization, but must never persist it.

**Why:** the `gmail.metadata` scope rejects `messages.list` calls that use the `q` parameter (needed for `newer_than:` backfill windows). Metadata-only sync prevents broad body collection; live, authorized previews provide necessary context without building a stored email-body corpus.

**How to apply:** keep setup instructions pointing at `gmail.readonly`; never "tighten" it to gmail.metadata or backfill breaks. Continue using `format=metadata` for sync. A preview must verify the viewer can read the owning mailbox, fetch only the selected Gmail message on demand, cap the returned text, and avoid database or durable client persistence.
