---
name: Printavo API error quirks
description: GraphQL errors that carry salvageable partial data, transient server timeouts, and the queue-starvation lesson for permanently-failing records.
---

# Printavo API error quirks

## Deleted-record "non-nullable" bug — salvage partial data
Orders referencing a later-deleted record (observed: PurchaseOrder.vendor) make Printavo error with `Cannot return null for non-nullable field ...` in an HTTP 200 — but the response still carries everything else in `data`.
**Why:** ~35 real orders (Feb 2018+) permanently fail otherwise; the data alongside the error is complete except the nulled subtree.
**How to apply:** salvage partial data ONLY when *every* error message starts with that prefix AND the root node survived null propagation; record the messages with the stored blob; guard against nulled-out nested nodes when flattening. Any other error mix must still throw.

## Transient "Timeout on X" GraphQL errors — retry
Printavo sporadically reports internal server timeouts as GraphQL errors (observed: `Timeout on IDed.id`) in an HTTP 200. One of these killed an hours-long backfill run.
**Why:** queries are read-only, so re-sending is safe; a bounded backoff retry (5s/15s/30s) absorbs the hiccup. Distinct from the 10k-window error ("Oops! Something went wrong") — do NOT retry that.
**How to apply:** retry only when ALL error messages start with "Timeout on"; bounded attempts, then throw.

## Starvation lesson: stamp attempts, don't just order by recency
A newest-first work queue with a fixed per-cycle batch will starve forever if permanently-failing items sit at the front — they eat the whole batch every cycle.
**Why:** the extras drip burned 175+ error cycles on ~35 broken orders while a ~16k backlog never drained.
**How to apply:** stamp `attempted_at` BEFORE each try (crash-safe: a crash just delays that item), order by `attempted_at ASC NULLS FIRST, recency DESC`, and reset `attempted_at` to NULL whenever an item genuinely changes so it rejoins the front tier.
