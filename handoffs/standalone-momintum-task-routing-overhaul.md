# Handoff: Printavo task-sync routing overhaul (2026-07-20)

Audience: the standalone moMINTum app team. The hub's Printavo⇄moMINTum task
sync changed how synced tasks are placed, and the hub made data-row changes in
the shared live DB that you will see. **No schema changes were made to the
moMINTum database.**

## What changed in the shared data

1. **"Assigned to Me" list is GONE (deleted).** The Printavo team's shared
   "Assigned to Me" list (was id 8) and its list-group membership row were
   deleted after all its tasks were re-routed. Tasks that pointed at it were
   re-homed by the sync; the 3 completed stragglers fell back to
   `list_id = NULL` via the existing `ON DELETE SET NULL` FK.

2. **New shared list: "Printavo → Production"** (same team, `owner_id NULL`,
   amber #f59e0b, nested in the "Printavo" sidebar group). Holds Printavo
   tasks tied to an invoice/quote that have **no matched assignee** (~98 open
   tasks after the first cycle, including 64 newly imported order tasks that
   were previously skipped by the sync).

3. **Private twins.** Printavo tasks whose assignee email matches a moMINTum
   member are now synced as PRIVATE tasks: `list_id = NULL`,
   `assignee_id = <member>`, no shared list at all (46 open today). They are
   visible only through the member's own views (Assigned to me / Today /
   date views) — and to admins in all-tasks-style views (see caveat below).

4. **Routing rules going forward** (per sync cycle):
   - assignee email matches a member → private (`list_id NULL` + assignee);
   - no assignee OR unmatched email, tied to invoice/quote → "Production";
   - no assignee OR unmatched email, not order-tied → "General";
   - customer-tied without matched assignee: mirror-only (never created).
   The sync re-applies placement ONLY when the routing outcome or the
   Printavo assignee changes — if a user manually moves a synced task to
   another list, the sync leaves it there.

5. **Notes enrichment.** Twins tied to an invoice/quote now get three extra
   note lines at creation (blank fields skipped):
   `Customer: <contact full name>` / `Company: <company>` /
   `Nickname: <order nickname>`. A one-time backfill appended these lines to
   67 pre-existing open twins (only where the "Synced from Printavo (task #"
   marker was still present in notes).

## What the hub app changed in ITS OWN task views (mirror if you want parity)

- **Quarantine of Printavo shared lists**: the hub's task-list API excludes
  tasks whose `list_id` is one of the Printavo team's shared lists
  (`teams.name = 'Printavo'`, `lists.owner_id IS NULL`) from EVERY query that
  doesn't filter on an explicit `listId` — so General/Production tasks appear
  ONLY on their own list pages, never in Today / Upcoming / Week / Calendar /
  All tasks / search. Tyler explicitly wants this in both apps: ~150 shared
  synced tasks with due dates would otherwise bury everyone's date views.
- **Inbox filter**: the hub's inbox (tasks with no list) additionally excludes
  `source = 'printavo'` tasks — otherwise the private twins (list-less by
  design) flood every admin's inbox. Recommend the same filter in the
  standalone app.

## Caveats

- **Admin visibility**: private twins are ordinary tasks with
  `list_id NULL`; any view that shows "all tasks" to admins will show other
  people's private synced tasks. This matches the previous behavior of
  admin views and was accepted by Tyler.
- The sync's routing baseline (`last_synced_list_kind`) lives in the HUB's
  own database, not the shared one.
- Unmatched Printavo assignee emails today (route as-if-unassigned):
  c.cortez@, nick@, andrew@, samantha@ (mintprintworks.com). If member rows
  with these emails are added to moMINTum, the next hub sync cycle will
  automatically flip their tasks to private.
