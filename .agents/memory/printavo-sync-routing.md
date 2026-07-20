---
name: Printavo task-sync routing invariants
description: Durable rules for the Printavo⇄moMINTum task sync routing layer — placement gating, quarantine convention, and Printavo API timeout quirk.
---

# Placement gating
Rule: list placement is re-applied only when the routing OUTCOME changes (kind or PV assignee email, or NULL baseline). Any future field that participates in placement (e.g. assigneeId) must be written in the list-move branch too, not only the content-change branch.
**Why:** a matched-status flip (member row added/removed for an unchanged email) changes routing without changing the email — the content branch stays cold, and the twin ended up list-less AND assignee-less (invisible everywhere). Caught by architect review 2026-07-20.
**How to apply:** when touching the twin-update `.set({...})` in sync.ts, keep listId and assigneeId together in the listChanged spread.

# Quarantine convention (both apps)
Tasks in the Printavo team's SHARED lists (Production/General) must be hidden from every task query that lacks an explicit listId filter (Today/Upcoming/Calendar/All/search), in the hub AND (per handoff) the standalone moMINTum app. Inbox additionally excludes source='printavo' (private twins are list-less by design).
**Why:** ~150 shared synced tasks with due dates bury everyone's date views; Tyler explicitly wants list-page-only visibility.
**How to apply:** any NEW task-listing endpoint or view must apply the same quarantine + inbox source filter; dashboard counts and lists-page counts currently do NOT (known cosmetic gap, Tyler informed).

# Printavo API quirk
The enriched tasks query (order nickname + contact fullName/companyName) intermittently fails with "Timeout on IDed.id" — transient; one retry succeeds. Sync tolerates per-task failures; any bulk script must retry per page.
