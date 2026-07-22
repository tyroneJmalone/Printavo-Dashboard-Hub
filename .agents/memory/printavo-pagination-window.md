---
name: Printavo 10k pagination window
description: Printavo offset pagination hard-caps at 10,000 rows; totalNodes caps at 10,000; how to detect and route around it
---

# Printavo 10,000-row pagination window (verified live July 2026)

The rule: any Printavo connection (invoices, quotes, …) is only pageable
through its first 10,000 rows for a given sort direction.

Observed behavior (invoices, ~14–15k real rows):
- `totalNodes` returns exactly 10,000 when the real count exceeds it
  (quotes at 4,133 report truthfully). A returned 10,000 means "10k or more".
- Requesting `after` >= offset 10,000 errors with the generic
  "Oops! Something went wrong. Try again later." — indistinguishable from a
  transient failure by message alone.
- The boundary page is CLEAN: a page ending at row 10,000 returns its rows
  and reports `hasNextPage: false`. Crawls terminate naturally, no error.
  This means `hasNextPage: false` is ambiguous — true end vs window cap.

**How to detect the cap:** cursors are unpadded base64 integer offsets
("Mw" = 3). Decode the final endCursor: 10,000 ⇒ capped, less ⇒ true end.

**How to route around it:** crawl both directions with `sortOn: VISUAL_ID`
(sort is monotonic in visual id) — ascending covers the oldest 10k; if
capped, a descending sweep from the top runs until it descends to the
ascending pass's last visual id (exact stop rule). Union is complete while
the connection holds ≤ 20k rows. Beyond that, the middle 
is unreachable via list pagination and needs another access path
(e.g. visual-id search).

**Why:** the full-history backfill design depends on this; a single-direction
crawl silently loses everything past row 10,000.

**How to apply:** any future feature that pages deep into Printavo lists
(orders, transactions, …) must decode cursor offsets and plan for the window;
never trust `totalNodes` ≥ 10,000 or a bare `hasNextPage: false` deep in a list.

Related: visual ids are NOT date-ordered (invoice #1000 is from 2021;
#4001 is Feb 2018) — crawl to list end, don't stop at a target date.
