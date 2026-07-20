# Handoff: Send-to-Printavo from moMINTum tasks (hub feature)

**Date:** 2026-07-20
**Hub change:** Staff can now send a moMINTum task TO Printavo from the task
detail modal (hub's copy of the moMINTum UI). This creates a standalone
Printavo calendar task and links the pair in the hub's `printavo_task_links`
table with `origin = "momintum"`.

## What the standalone app team needs to know

The standalone app's database gets **no schema changes** (link table lives in
the hub DB). But moMINTum tasks that were sent to Printavo now participate in
the hub's Printavo sync, so their behavior changes in ways users may notice:

1. **Completion syncs both ways.** Checking off a sent task in moMINTum marks
   the Printavo task complete on the next sync cycle, and vice versa
   (identical to Printavo-origin twins from the earlier handoff).
2. **Content does NOT sync for sent tasks.** Title/due-date/assignee edits
   made in moMINTum after sending do not propagate to Printavo, and Printavo
   edits do not overwrite the moMINTum task (the content mirror is
   Printavo-origin only, by design). Completion is the only two-way field.
3. **Deleting the moMINTum original orphans the Printavo task.** The link is
   suppressed permanently; the Printavo task stays open in Printavo and is
   never touched again. Re-sending a restored task is blocked ("previously
   linked") to avoid duplicating a possibly-still-alive Printavo task —
   the workaround is duplicating the task and sending the copy.
4. **Deleting the Printavo copy soft-deletes the moMINTum task** (restorable
   from trash, same twin semantics as before). After restore, the task can be
   sent again (the link is dropped, not suppressed, in this direction).
5. **Recurring tasks can't be sent** (Printavo completion would respawn an
   unlinked occurrence). Tasks also need a due date first — Printavo requires
   one on task creation.
6. **Notes are never touched.** Unlike Printavo-origin twins, sent tasks get
   no "(INV #…)" suffix or notes block; the link badge in the hub UI is the
   only indicator.

## Hub-side implementation (for reference)

- Routes: `GET /api/momintum/tasks/:id/printavo-link` (link status) and
  `POST /api/momintum/tasks/:id/send-to-printavo` (any staff, not admin-only)
  in `artifacts/api-server/src/momintum/printavoLink.ts`.
- Assignee mapping: moMINTum member email → Printavo user email
  (case-insensitive); no match → created unassigned, surfaced in the toast.
- Link baseline is built from Printavo's taskCreate response (its normalized
  echo), `lastSyncedCompleted = false`, `lastSeenAt = null` until first scan.
- Failure handling: if the link insert fails after taskCreate, the Printavo
  task is deleted (compensating rollback) so no unlinked task survives.
- UI: `artifacts/momintum/src/components/tasks/task-detail.tsx` — "Send to
  Printavo" button when eligible, "Synced with Printavo" badge when linked.

If the standalone app ever wants this button, port the UI block + the two
routes; the sync engine already handles momintum-origin links.
