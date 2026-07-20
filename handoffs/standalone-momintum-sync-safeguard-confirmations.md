# Handoff: Confirmation safeguards on Printavo-synced tasks — for the standalone moMINTum app

**Date:** July 20, 2026
**From:** Printavo Hub (which shares this app's live Postgres database)
**Goal:** Nothing to build (optional mirror suggestion in §3). This is an awareness handoff: the hub's moMINTum frontend now shows a confirmation dialog before users complete, reopen, delete, or content-edit a task that is actively synced with Printavo.

---

## 1. What the hub added (hub-side only)

- The hub's task API now decorates tasks with `printavoLinked: true` when an **active** (non-suppressed) Printavo sync link exists for that task. The link bookkeeping lives in the **hub's own database** — no schema or data changes in this app's database.
- The hub's moMINTum frontend shows an AlertDialog before these actions on a linked task:
  - **Complete / reopen** — warns the state also pushes to Printavo on the next sync cycle.
  - **Delete** — warns the Printavo task stays untouched but the sync connection is permanently removed (a user-deleted task never re-syncs; this matches the existing sync rule).
  - **Edit of title / notes / dueDate** — warns the change stays local and may be overwritten if the task changes in Printavo. Edits to list, priority, tags, or assignee are NOT guarded (the sync respects those as user intent).
- Bulk complete/delete shows one dialog with the count of synced tasks among the selection.

## 2. Why this exists

Users were completing/deleting synced tasks without realizing the action propagates to Printavo (or permanently kills the sync, for deletes). The dialogs make the consequence explicit before the write happens. The sync engine's behavior is unchanged — these are purely frontend confirmations.

## 3. Optional: mirroring this in the standalone app

If this app wants the same safeguard:

- **Received twins are detectable**: tasks with `source = 'printavo'` are hub-created twins — the same complete/reopen/delete consequences apply to them, so the same dialog copy works.
- **One gap you cannot close**: tasks users created here and "sent to Printavo" via the hub are linked in the **hub's database only** — this app has no way to know they're synced. Accept the gap or ask the hub team for an API if it ever matters.
- **Suppressed links**: after a user deletes a synced task, the link is suppressed and the task (if restored from trash) will never sync again — no warning is needed on such a task. Using `source = 'printavo'` as the trigger would over-warn on restored-from-trash twins; that's a minor false positive, judge for yourselves.

## 4. Rules unchanged

All rules from previous handoffs still apply — especially: `completed` / `completed_at` / `deleted_at` semantics on `tasks` must not change, and a user-deleted task stays deleted (sync stops permanently, Printavo task untouched).
