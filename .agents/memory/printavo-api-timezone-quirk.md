---
name: Printavo API timezone-rendering quirk
description: Printavo renders date-only fields in inconsistent timezones per node; transactionDate needs per-node canonicalization
---

# Printavo API renders dates in random server timezones

**The quirk:** Printavo's GraphQL API renders the same node in different
timezones across fetches — observed `Z` (UTC), `-04:00` (Eastern), and
`-05:00` (Central), varying **per node within a single response** (likely
cached serialized fragments). Full ISO timestamps are safe (same instant,
different offset — canonicalize to UTC before hashing). Date-only strings
are NOT safe: the date cast happens in the render timezone, so
`transactionDate` flip-flops ±1 day between fetches.

**Two anchor classes (confirmed empirically, July 2026):**
- **PROCESSOR payments (credit card):** `transactionDate` is anchored at the
  payment's creation instant. Evening-ET payments render as the next day
  under UTC.
- **MANUAL payments (check/cash) and user-edited dates:** anchored at
  midnight Eastern (account TZ). A server west of Eastern renders D-1
  (e.g. a 12:39pm ET cash payment rendered by a -05:00 server showed the
  previous day).

**Detection & fix:** the node's own raw `timestamps.createdAt` offset
reveals the render TZ. If rendered txnDate == creation instant cast in
render TZ → instant-anchored → canonical = creation instant's Eastern date.
Otherwise → midnight-ET anchored → add 1 day when render offset is west of
Eastern's offset at that instant. Must run on the RAW node before timestamp
normalization (which erases the offset evidence) and before content
hashing (so hashes are stable across render TZs).

**Why order date fields are unaffected:** `invoiceAt`, `paymentDueAt`,
`customerDueAt`, `dueAt` on orders never exhibited flips across dozens of
full crawls — they appear to be backed by true date columns, not
timezone-cast datetimes. Only `transactionDate` needed correction.

**Also learned:** Printavo connections drop with transient ECONNRESET
(undici "fetch failed"/"terminated" TypeErrors) often enough to kill long
crawls — the client needs network-level retry with backoff, not just 429
handling.

**How to apply:** any new date-only field synced from Printavo should be
watched for ±1-day flip-flop in change_events before trusting it; if it
flips, run it through the same canonicalization.
