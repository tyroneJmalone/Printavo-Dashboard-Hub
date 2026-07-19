# Handoff: Two-way task completion sync (Printavo ⇄ moMINTum) — for the standalone moMINTum app

**Date:** July 19, 2026
**From:** Printavo Hub (which shares this app's live Postgres database)
**Goal:** Nothing to build. This is an awareness handoff: the hub's Printavo task sync now WRITES completion state, reopen state, and soft-deletes to rows in this app's `tasks` table. Read this so future changes in this app don't fight the sync.

---

## 1. What the hub sync now does to `tasks` rows

All of this applies **only to tasks the hub created itself** (`tasks.source = 'printavo'` — the "twins" of Printavo tasks). The hub never touches tasks users created in this app.

1. **Completes twins**: when a task is completed in Printavo, the hub sets `completed = true` and stamps `completed_at` on the twin.
2. **Reopens twins**: when a task is reopened in Printavo, the hub sets `completed = false` and clears `completed_at`.
3. **Pushes completions the other way**: when a user completes/reopens a twin **in this app**, the hub pushes that state to Printavo on its next sync cycle. No action needed here — normal `completed` writes are the trigger.
4. **Soft-deletes twins**: when the Printavo task is deleted in Printavo, the hub sets `deleted_at` on the twin (same soft-delete this app's own delete uses). The twin will appear in this app's trash — that is expected, and restoring it from trash will NOT recreate the Printavo task.
5. **Respawns recurring twins on completion**: the hub replicated this app's exact PATCH-route respawn behavior (same fields copied, `recurring_parent_id` chained, next due date by daily/weekly/monthly/yearly). If a twin somehow has a recurrence set, completing it via sync spawns the next occurrence exactly like completing it in this app would. Respawned copies do **not** inherit `source`, so they are ordinary tasks owned by this app.

## 2. Rules this app should keep respecting

1. **`completed` / `completed_at` / `deleted_at` semantics must not change** on the `tasks` table — the hub mirrors them 1:1 to Printavo. If this app ever adds a different completion model (e.g., statuses), coordinate first.
2. If this app's recurrence-respawn logic in the complete-task path ever changes (different fields copied, different date math), tell the hub — the hub keeps a field-for-field copy so both paths behave identically.
3. A task deleted by a user **in this app** stays deleted: the hub notices, stops syncing that pair permanently, and never deletes or modifies the Printavo task because of it.
4. As always: no schema changes needed or wanted from this handoff; the hub's bookkeeping lives in the hub's own database.

## 3. User-visible behavior to be aware of (support questions)

- Tasks in the "Printavo" lists can complete/reopen "by themselves" — that's the sync mirroring Printavo, typically within one sync cycle of the change in Printavo.
- Completed Printavo twins may take a little longer to reconcile than open ones (completed tasks are checked individually with a per-cycle cap to respect Printavo's API rate limit).
- Items appearing in trash that no user deleted = the Printavo task was deleted in Printavo.
- One deliberate edge: once a task pair is completed on **both** sides, the hub stops checking it (to respect Printavo's API rate limit). If someone later deletes that already-completed task in Printavo, its twin stays as a completed task in this app — it is NOT moved to trash. That is by design, not a bug.
