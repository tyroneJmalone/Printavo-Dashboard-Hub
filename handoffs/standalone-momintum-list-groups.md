# Handoff: List Groups (sidebar folders) — for the standalone moMINTum app

**Date:** July 19, 2026
**From:** Printavo Hub (which shares this app's live Postgres database)
**Goal:** Make the standalone moMINTum app display and manage the same list-group folders the hub now has, so both apps look and work the same.

---

## 1. Critical context — read first

- The hub and this app share the **same live Postgres database**. The hub has already created two new tables in it: `list_groups` and `list_group_memberships`. **The tables and their data already exist in production. Do NOT create them again, do NOT run a migration that would drop or alter them, and do NOT let schema tooling (drizzle push, prisma migrate, etc.) treat them as "unknown tables to remove."**
- Do **not** add a `group_id` column to the `lists` table. Group membership deliberately lives in a separate table so that neither app's schema tooling touches the other's tables.
- There is already one group in production: **"Printavo"** (contains the lists "Assigned to Me" and "General", which are managed by the hub's Printavo task sync). Don't hardcode or special-case it — it's an ordinary group row.

## 2. Existing schema (already live — reference only)

```sql
-- ALREADY EXISTS IN PRODUCTION. For reference only — do not execute.
CREATE TABLE list_groups (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#5B6B99',
  sort_order double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_group_memberships (
  list_id    integer PRIMARY KEY REFERENCES lists(id) ON DELETE CASCADE,
  group_id   integer NOT NULL REFERENCES list_groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Semantics:
- A list belongs to **at most one** group (`list_id` is the primary key of the membership table).
- Deleting a list (either app) automatically removes its membership (cascade).
- Deleting a group automatically removes its memberships (cascade) — **the lists themselves survive** and become ungrouped.
- `sort_order` orders groups in the sidebar (ascending, ties broken by `id`).
- If you define these tables in the app's ORM, mark them so migrations never drop them (e.g., include them in the schema definition so the tooling considers them known).

## 3. Behavior to replicate (how the hub does it)

### Sidebar
- Groups render as **collapsible folders** in the lists section of the sidebar, sorted by `sort_order` then `id`.
- Inside each folder: that group's lists (normal list rows, same as today).
- A group with no lists shows the folder with an "Empty" placeholder.
- **Ungrouped lists render after all groups**, as flat rows (exactly like today's sidebar).
- Defensive rule: a list whose membership points at a group that isn't in the loaded groups (e.g., group deleted mid-session) must render as **ungrouped**, never disappear.
- Collapsed/expanded state is per-browser (the hub uses localStorage key `momintum-sidebar-groups-collapsed`, a JSON array of collapsed group ids — reuse the same key only if the apps share a domain; otherwise any equivalent is fine).

### Lists page
- "New Group" action: dialog with name (required) + color. Creates a `list_groups` row.
- Each group shown as a chip/section with a delete action. Deleting asks for confirmation and warns that **lists are kept** (they just become ungrouped).
- The create-list form has an optional "Group" select (default: no group). On create, insert the list, then upsert the membership.

### List detail page
- A "Group" select showing the current group (or "No group"). Changing it upserts/deletes the membership row:
  - Set to a group → `INSERT ... ON CONFLICT (list_id) DO UPDATE SET group_id = ...`
  - Set to "No group" → `DELETE FROM list_group_memberships WHERE list_id = ...`
- Validate the group exists before writing; reject with a clear error if not (the hub returns 400 "List group not found").

### API surface (hub's shape, adapt to this app's conventions)
- `GET /list-groups` → all groups ordered by sort_order, id
- `POST /list-groups` `{name, color?, sortOrder?}` → created group
- `PATCH /list-groups/:id` `{name?, color?, sortOrder?}` → updated group (404 if missing)
- `DELETE /list-groups/:id` → 204 (memberships cascade; lists survive)
- List DTOs gain a `groupId: number | null` field, populated by joining `list_group_memberships` on read. Strip `groupId` from any direct write to the `lists` table — it is never a `lists` column.

## 4. Hard warnings (repeat)

1. **Never** drop or recreate `list_groups` / `list_group_memberships` — they contain live production data used by the hub.
2. **Never** add columns to `lists` (or other existing tables) for this feature.
3. **Never** write `members.clerk_user_id` from anywhere new (existing standing rule between the two apps).
4. The "Printavo" group and its two lists are re-created by the hub's sync **only if the group is missing entirely** — user moves/ungroups of those lists are respected. Mirror that: no auto-re-nesting logic needed in this app at all.
