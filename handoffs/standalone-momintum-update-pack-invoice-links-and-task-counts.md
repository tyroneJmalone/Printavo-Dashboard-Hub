# moMINTum standalone update pack: Printavo invoice links + accurate task counts

Two updates in one document. Paste the whole thing to the standalone moMINTum agent. Apply Part 1 first; Part 2 is independent of it but listed second.

## Context: how this app relates to the Printavo Hub (read before changing anything)

**The setup.** moMINTum exists in two places: this standalone app (the published, user-facing one) and a copy embedded inside Mint Printworks' internal "Printavo Hub" workspace. Both frontends read and write the SAME live production Postgres database — this app's database. There is one set of tasks, lists, and members; only the UI code is duplicated.

**Who owns what:**
- **This standalone app owns the database schema.** All migrations and schema tooling live here. The Hub never runs schema pushes against this DB; when the Hub needs new persistent state it adds separate, clearly hub-owned tables (currently `list_groups` and `list_group_memberships`, used for the sidebar list folders) with cascade FKs. Never drop or migrate away those tables — the Hub depends on them.
- **This app owns user identity.** Each app has its own separate Clerk tenant; `members.clerk_user_id` belongs to THIS app's tenant. The shared identity key between the two apps is **email only** (case-insensitive, oldest row wins). Email must NOT gain a unique index — the Hub relies on the current shape.
- **The Hub owns the Printavo sync.** A poller in the Hub's API server mirrors Printavo orders into tasks (titles ending "(INV #NNN)", Printavo URL in notes, the shared "Printavo" team's General/Production lists, quarantine behavior). This app should treat all of that as read-mostly data it renders — never re-implement or modify the sync itself.

**The ideals (why these handoffs exist):**
- **Feature parity, ported deliberately.** UI features are usually built first in the Hub's copy, then ported here via handoff docs like this one — code is adapted, not blindly copied, because this app has its own backend and API layer.
- **Symmetric behavior.** Because both apps serve the same rows, gating and semantics must match on both sides (e.g. if an endpoint isn't admin-gated in one app, don't "fix" it in only one). If a handoff specifies a rule (like quarantine list matching by team name "Printavo", never hardcoded ids), keep it identical.
- **Additive and reversible.** Prefer read-side and frontend changes; avoid destructive migrations; anything touching shared rows should be something the other app can tolerate without changes.

If a requested change seems to conflict with any of the above, flag it rather than working around it.

---

# PART 1 of 2

# Handoff: Clickable Printavo order links on synced task titles (hub-side UI feature)

Date: 2026-07-20
From: Printavo Hub agent
To: Standalone moMINTum app agent

## What changed (hub app only — no data or schema changes)

In the hub's moMINTum frontend, tasks synced from Printavo now render the
trailing "(INV #NNN)" part of their title as a clickable link that opens the
Printavo order in a new tab. The task detail dialog also shows an
"Open order in Printavo" link when the URL is available.

Nothing about the shared database changed. This is purely presentation.

## How it works (so you can replicate for a consistent experience)

Printavo-synced twins already carry everything needed:

- Title ends with ` (INV #<visualId>)` — e.g. `Send for Digitizing (INV #22476)`
- Notes contain the staff-facing order URL, written once at twin creation:
  `Invoice #<visualId>: https://www.printavo.com/invoices/<internalId>`

The UI logic:

1. Match the title against `/^(.*)(\(INV #[^)]+\))(\s*)$/`.
2. If it matches, extract the first `https://www.printavo.com/invoices/\d+`
   URL from the task's notes.
3. If both are present, render the "(INV #NNN)" suffix as an
   `<a href={url} target="_blank" rel="noopener noreferrer">` and call
   `stopPropagation()` on the anchor's click so row-level click handlers
   (open detail / inline edit) don't fire.
4. If either is missing (user edited the title or notes), fall back to
   plain text — the link simply doesn't render; nothing breaks.

## Caveats

- The notes are only written at twin creation and never overwritten by sync,
  so users editing notes can remove the URL — the link then disappears for
  that task. That's acceptable/by design.
- Customer-scoped Printavo tasks (titled `... (customer task)`) are NOT
  linked — only invoice-scoped tasks. (Their notes contain a
  `/customers/<id>` URL if you ever want to extend this.)

---

# PART 2 of 2

# For the standalone moMINTum app: accurate task counts on the Lists page and Dashboard

Paste this whole document to the agent working on the standalone moMINTum app.
Apply it AFTER the task-routing-overhaul handoff (it builds on the Printavo
quarantine filtering introduced there).

## What to build

Two count bugs, one cause: counts were derived from the filtered `GET /tasks`
response instead of being computed server-side.

1. **Lists page cards showed 0 for the quarantined Printavo lists.** The
   frontend counted `tasks.filter(t => t.listId === list.id).length` from
   `GET /tasks?completed=false` — but that endpoint excludes tasks in the
   quarantined Printavo shared lists (General/Production), so those list cards
   showed 0 despite holding 60+ synced order tasks.
2. **Dashboard summary counts included trashed and quarantined tasks**, so the
   numbers didn't match the task views the dashboard links to.

Fix: the list API computes an `activeTaskCount` per list server-side, and the
dashboard summary applies the same "no trashed, no quarantined" base filter as
the task views.

This changes the **API response** (new optional `activeTaskCount` field on
List) plus small frontend edits. No schema/database changes — counts are
computed from existing tasks at query time.

## 1. API: `GET /lists` returns `activeTaskCount`

In the lists route, after fetching the lists, compute per-list open-task
counts with one grouped query and merge them in (Drizzle shown; adapt to the
standalone app's query layer):

```ts
// Server-side per-list open-task counts. The FE can't derive these from
// GET /tasks because quarantined Printavo lists (General/Production) are
// excluded there — their cards would show 0 despite holding many tasks.
const counts = await db
  .select({ listId: tasksTable.listId, activeTaskCount: count() })
  .from(tasksTable)
  .where(
    and(
      eq(tasksTable.completed, false),
      isNull(tasksTable.deletedAt),   // exclude soft-deleted (trashed) tasks
      isNotNull(tasksTable.listId),
    ),
  )
  .groupBy(tasksTable.listId);
const countByListId = new Map(counts.map((c) => [c.listId, c.activeTaskCount]));

res.json(lists.map((l) => ({
  ...l,
  activeTaskCount: countByListId.get(l.id) ?? 0,
})));
```

Note this count deliberately does NOT apply the Printavo quarantine filter —
a quarantined list's own card should show its real count; quarantine only
hides its tasks from cross-list views.

If the app has an OpenAPI spec / shared List type, add the field there:

```yaml
activeTaskCount:
  type: integer
  description: Count of open (not completed, not trashed) tasks in this list. Computed server-side so quarantined Printavo lists still show real counts. Present on GET /lists only.
```

(Keep it optional — other endpoints returning a List don't include it.)

## 2. API: dashboard summary applies the same base filter as task views

In the dashboard summary route, build a shared set of base conditions and
prepend it to BOTH the active-count conditions and the completed-today
conditions:

```ts
// Match the task-list views the dashboard links to: no trashed tasks, and
// no tasks quarantined in the Printavo shared lists (General/Production).
const baseConditions: SQL[] = [isNull(tasksTable.deletedAt)];
const pvListIds = await getPrintavoQuarantinedListIds();
if (pvListIds.length > 0) {
  const quarantineFilter = or(
    isNull(tasksTable.listId),
    notInArray(tasksTable.listId, pvListIds),
  );
  if (quarantineFilter) baseConditions.push(quarantineFilter);
}

const activeConditions = [...baseConditions, eq(tasksTable.completed, false)];
// ...existing assignee/date filters unchanged...

const completedConditions = [
  ...baseConditions,
  eq(tasksTable.completed, true),
  isNotNull(tasksTable.completedAt),
  gte(tasksTable.completedAt, startOfToday),
  // ...
];
```

`getPrintavoQuarantinedListIds()` is a small helper worth extracting so the
tasks route and the dashboard share one definition (the task-routing handoff
introduced this logic inline in the tasks route):

```ts
/**
 * Ids of the quarantined Printavo shared lists (General/Production under
 * the "Printavo" team). Tasks in these lists are hidden from all cross-list
 * views AND from dashboard counts — they surface only when the list itself
 * is opened.
 */
export async function getPrintavoQuarantinedListIds(): Promise<number[]> {
  const [printavoTeam] = await db
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .where(eq(teamsTable.name, PRINTAVO_TEAM_NAME))
    .orderBy(asc(teamsTable.id))
    .limit(1);
  if (!printavoTeam) return [];
  const pvSharedLists = await db
    .select({ id: listsTable.id })
    .from(listsTable)
    .where(and(eq(listsTable.teamId, printavoTeam.id), isNull(listsTable.ownerId)));
  return pvSharedLists.map((l) => l.id);
}
```

## 3. Frontend: Lists page uses the server count

Remove the client-side derivation and use the new field. Before:

```tsx
const { data: tasks } = useListTasks({ completed: false }); // delete this query
// ...
const activeCount = (tasks || []).filter((t) => t.listId === list.id).length;
```

After:

```tsx
const activeCount = list.activeTaskCount ?? 0;
```

(The dashboard page itself needs no frontend change — it just displays the
now-corrected summary numbers.)

## Constraints
- Do NOT change how tasks are created, synced, completed, or stored — this is
  a read-side counting fix only. No database schema changes, no writes.
- Do NOT apply the quarantine filter to the per-list `activeTaskCount` — only
  to the dashboard summary and cross-list task views.
- Keep the quarantine definition identical to the task-routing handoff:
  shared lists (no owner) belonging to the team named "Printavo". Match the
  team by name at runtime; never hardcode ids.
