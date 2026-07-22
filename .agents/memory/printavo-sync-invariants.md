---
name: Printavo sync invariants
description: Hard-won rules for the Printavo GraphQL sync — complexity cap tuning, hash stability, drip/backlog selection.
---

# Complexity cap is computed from page-size limits, not data
Printavo rejects queries whose *worst-case* cost exceeds 25,000 — computed purely from the `first:` limits in the query, regardless of actual data. **Why:** a probe with limits 10/25/12/6 returned "complexity 29,976 exceeds 25,000"; the error message states the exact computed cost. **How to apply:** when a query trips the cap, read the number in the error and shrink limits proportionally instead of guessing; big records just take extra paged requests.

# Never hash anything containing pagination cursors
Any record fingerprint (content hash) must have `endCursor`/pageInfo internals stripped first — cursors differ between fetch paths (list crawl vs single-order query) for identical content. **Why:** leaving them in causes phantom "changed" detections and hash churn between the crawl path and detail path. Same family as the existing timestamp-normalization rule.

# Widening hashed fields triggers a one-time rebase wave
Adding fields to a hashed selection re-fingerprints every synced record on the next poll: one very long poll plus thousands of cosmetic "updated" change events. **How to apply:** expect it, warn the user, and delete the spurious events afterward by `sync_run_id` (only `event_type='updated'` rows from that run).

# Backlog drip selection must be driven by the stale flag alone
Drip/backfill candidate queries must select on the boolean stale flag only — never `OR <data column> IS NULL`. **Why:** the missing-record path clears the flag but leaves the data NULL; matching on NULL re-selects deleted records every cycle forever, permanently burning rate budget and potentially wedging the whole backlog (caught by architect review in B1).
