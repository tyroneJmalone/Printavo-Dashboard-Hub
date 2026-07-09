---
name: Printavo API quirks
description: Non-obvious Printavo GraphQL API behaviors that affect sync and write-back design
---

# Read-after-write staleness
A `statusUpdate` mutation succeeds, but an immediate follow-up query (~1s later) can still return the OLD status. A post-write "refresh order detail" step may therefore persist stale data locally even though the write landed.

**Why:** Observed 2026-07-09 while testing the status-suggestions apply path: apply → refresh read old status; a direct query a few seconds later showed the new status. The periodic sync reconciled the local row.

**How to apply:** Never treat a post-write refresh as authoritative confirmation. Either delay the refresh a few seconds, or rely on the regular sync sweep to converge. Don't "fix" this by retry-looping the mutation — it already worked.

# Testing writes safely
Scratch invoice #19004 (Printavo id 19698321) is the sanctioned target for reversible write tests: apply a change, then apply the exact reverse through the same code path, and delete any synthetic DB rows afterward. PO 341 and live 22251-* orders must never be mutated.
