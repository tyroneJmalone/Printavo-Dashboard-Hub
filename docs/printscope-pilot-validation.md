# Read-only pilot validation — 2026-09-22

## Completed checks

- Generated API libraries, API server, and Hub typechecks passed.
- Focused backend tests passed.
- Authenticated browser pass used synthetic staff identities through Clerk's programmatic testing mechanism, without sign-in emails.
- Admin explicitly started a development-only pilot; dates matched 14 days of intake followed by 30 days of retention.
- Only the synthetic mirrored fixture was imported. Its inspection completed with private plates and visible incomplete-check warnings.
- Reimport returned the same inspection without increasing the cohort count.
- A FLAG review increased potential false clearances; a subsequent PASS correction reduced that count while leaving the engine result unchanged. Reload preserved the latest review.
- Staff could view the pilot and review form but had no start/rules-edit controls. Direct rules access was read-only.
- The iPad-width view rendered without apparent overlap.
- Real-storage retention checks verified exact-generation deletion, retry after a controlled failure, idempotency, stale-worker fencing, preserved metadata/reviews, and protection for shared/manual/mirror/other-environment objects. Wrong ownership prefixes blocked cleanup explicitly.

## Issue found and corrected

The browser pass found that only the latest human review was visible. A paginated review-history endpoint and UI were added. A read-only loopback API check against the actual browser-created records verified both reviews, newest-first ordering, pagination, nonpilot-job 404, and unauthenticated 401. The final UI includes history pagination and explicit loading/error states and passed typechecking. That final UI change was not subjected to a second authenticated browser pass.

## Final state

Temporary development pilot, fixture, test staff rows, and test-owned assets were cleaned up. No production pilot was started and no real upstream artwork was changed. Hub and API workflows restarted successfully; unauthenticated pilot access returned 401. Publishing and an explicit admin start are still required before the production pilot begins.