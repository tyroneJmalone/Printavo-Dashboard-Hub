import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  db as momintumDb,
  tasksTable,
  listsTable,
  teamsTable,
  membersTable,
  listGroupsTable,
  listGroupMembershipsTable,
  type Member,
} from "@workspace/momintum-db";
import {
  db as hubDb,
  printavoTaskLinksTable,
  type PrintavoTaskLink,
} from "@workspace/db";
import { tasksPageQuery } from "@workspace/printavo";
import { getPrintavoClient } from "../lib/printavoGateway";

/**
 * Printavo ⇄ moMINTum task sync engine.
 *
 * PHASE 2 SCOPE (current): one-way IMPORT — Printavo → moMINTum. Creates and
 * content-updates moMINTum twins for open Printavo tasks. Never writes to
 * Printavo. Two-way completion, vanished-task probes and send-to-Printavo
 * come in later phases.
 *
 * Ownership rules (see replit.md):
 * - moMINTum DB is the standalone app's LIVE prod DB — data-row writes only,
 *   never schema changes, never members.clerk_user_id, no JIT member
 *   creation from sync (unmatched assignee emails route to General).
 * - The link table lives in the HUB's own DB (@workspace/db).
 * - All Printavo traffic goes through the shared throttled gateway.
 */

const TEAM_NAME = "Printavo";
const ASSIGNED_LIST_NAME = "Assigned to Me";
const GENERAL_LIST_NAME = "General";
const TEAM_COLOR = "#16a34a";
const ASSIGNED_LIST_COLOR = "#16a34a";
const GENERAL_LIST_COLOR = "#2baeae";
const ENSURE_LOCK_KEY = "momintum:printavo-task-sync:ensure";

// ── Printavo response shapes (fields per tasksPageQuery) ────────────────

interface PvUser {
  id: string;
  name: string | null;
  email: string | null;
}

interface PvTaskable {
  __typename: "Invoice" | "Quote" | "Customer";
  id: string;
  visualId?: number | string | null;
}

export interface PvTaskNode {
  id: string;
  name: string;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  assignedTo: PvUser | null;
  taskable: PvTaskable | null;
  timestamps: { createdAt: string; updatedAt: string };
}

interface TasksPage {
  tasks: {
    nodes: PvTaskNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// ── Cycle summary (exposed via /status) ─────────────────────────────────

export interface SyncSummary {
  trigger: string;
  dryRun: boolean;
  startedAt: string;
  durationMs: number;
  scanned: number;
  created: number;
  contentUpdated: number;
  listMoved: number;
  skippedUnassignedOrderTasks: number;
  suppressedLinks: number;
  unmatchedAssigneeEmails: string[];
  errors: string[];
}

let lastRun: SyncSummary | null = null;
let running = false;

export function getLastRunSummary(): SyncSummary | null {
  return lastRun;
}

export function isSyncRunning(): boolean {
  return running;
}

// ── Building blocks ──────────────────────────────────────────────────────

/**
 * JIT-ensure the "Printavo" team plus its two shared lists. Advisory-locked:
 * neither teams.name nor lists.name is unique in the standalone schema, so
 * concurrent ensures would create duplicates. Lists are created with
 * ownerId=null (shared → visible to everyone) and teamId set (badge only).
 */
export async function ensurePrintavoGroup(): Promise<{
  assignedListId: number;
  generalListId: number;
}> {
  return momintumDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${ENSURE_LOCK_KEY}))`,
    );

    let [team] = await tx
      .select()
      .from(teamsTable)
      .where(eq(teamsTable.name, TEAM_NAME))
      .orderBy(asc(teamsTable.id))
      .limit(1);
    if (!team) {
      [team] = await tx
        .insert(teamsTable)
        .values({ name: TEAM_NAME, color: TEAM_COLOR })
        .returning();
    }
    if (!team) throw new Error("Failed to ensure Printavo team");

    const ensureList = async (name: string, color: string): Promise<number> => {
      const [existing] = await tx
        .select()
        .from(listsTable)
        .where(sql`${listsTable.name} = ${name} AND ${listsTable.teamId} = ${team.id} AND ${listsTable.ownerId} IS NULL`)
        .orderBy(asc(listsTable.id))
        .limit(1);
      if (existing) return existing.id;
      const [created] = await tx
        .insert(listsTable)
        .values({ name, color, teamId: team.id, ownerId: null })
        .returning();
      if (!created) throw new Error(`Failed to ensure list ${name}`);
      return created.id;
    };

    const assignedListId = await ensureList(
      ASSIGNED_LIST_NAME,
      ASSIGNED_LIST_COLOR,
    );
    const generalListId = await ensureList(GENERAL_LIST_NAME, GENERAL_LIST_COLOR);

    // Nest both lists under a "Printavo" sidebar group (JIT, same lock).
    // Memberships are seeded ONLY when the group is first created — if Tyler
    // later ungroups or moves these lists, the sync must not undo that.
    const [existingGroup] = await tx
      .select()
      .from(listGroupsTable)
      .where(eq(listGroupsTable.name, TEAM_NAME))
      .orderBy(asc(listGroupsTable.id))
      .limit(1);
    if (!existingGroup) {
      const [group] = await tx
        .insert(listGroupsTable)
        .values({ name: TEAM_NAME, color: TEAM_COLOR })
        .returning();
      if (group) {
        await tx
          .insert(listGroupMembershipsTable)
          .values([
            { listId: assignedListId, groupId: group.id },
            { listId: generalListId, groupId: group.id },
          ])
          .onConflictDoNothing();
      }
    }

    return { assignedListId, generalListId };
  });
}

/** Read-only lookup for dry runs; sentinels when the group doesn't exist. */
async function lookupPrintavoGroupReadOnly(): Promise<{
  assignedListId: number;
  generalListId: number;
}> {
  const [team] = await momintumDb
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.name, TEAM_NAME))
    .orderBy(asc(teamsTable.id))
    .limit(1);
  if (!team) return { assignedListId: -1, generalListId: -2 };
  const lists = await momintumDb
    .select()
    .from(listsTable)
    .where(eq(listsTable.teamId, team.id))
    .orderBy(asc(listsTable.id));
  return {
    assignedListId:
      lists.find((l) => l.name === ASSIGNED_LIST_NAME && !l.ownerId)?.id ?? -1,
    generalListId:
      lists.find((l) => l.name === GENERAL_LIST_NAME && !l.ownerId)?.id ?? -2,
  };
}

/** Lowercase email → member (oldest row wins — email is not unique). */
async function buildMemberEmailMap(): Promise<Map<string, Member>> {
  const members = await momintumDb
    .select()
    .from(membersTable)
    .orderBy(asc(membersTable.id));
  const map = new Map<string, Member>();
  for (const m of members) {
    const email = m.email?.trim().toLowerCase();
    if (email && !map.has(email)) map.set(email, m);
  }
  return map;
}

export async function fetchAllOpenPvTasks(): Promise<PvTaskNode[]> {
  const client = getPrintavoClient();
  const all: PvTaskNode[] = [];
  let after: string | null = null;
  // Hard ceiling of 40 pages (=1000 tasks) so a runaway account can never
  // wedge the shared gateway for minutes.
  for (let page = 0; page < 40; page++) {
    const data: TasksPage = await client.query<TasksPage>(
      tasksPageQuery({ after, completed: false }),
    );
    all.push(...data.tasks.nodes);
    if (!data.tasks.pageInfo.hasNextPage) break;
    after = data.tasks.pageInfo.endCursor;
    if (!after) break;
  }
  return all;
}

interface DesiredMirror {
  /** Which list the twin belongs in. */
  listKind: "assigned" | "general";
  title: string;
  assigneeEmail: string | null;
  /** False for invoice/quote tasks with no assignee: mirror only if a link
   *  already exists (they were assigned once), never create fresh. */
  createIfMissing: boolean;
}

/** Tyler's routing spec (rev. 2026-07-19): ANY task with an assignee goes to
 *  "Assigned to Me" (falls back to General when the email doesn't match a
 *  moMINTum member); unassigned tasks go to General. Order-tied tasks without
 *  an assignee are never created fresh (mirror-only if a link exists). */
export function routePvTask(t: PvTaskNode): DesiredMirror {
  const email = t.assignedTo?.email?.trim().toLowerCase() || null;
  const suffix = !t.taskable
    ? ""
    : t.taskable.__typename === "Customer"
      ? " (customer task)"
      : ` (INV #${t.taskable.visualId ?? "?"})`;
  return {
    listKind: email ? "assigned" : "general",
    title: `${t.name}${suffix}`,
    assigneeEmail: email,
    createIfMissing: t.taskable ? email !== null : true,
  };
}

/** Notes for a freshly created twin — includes the staff-facing Printavo URL
 *  for order/customer-tied tasks. Notes are user-owned after creation; the
 *  sync never overwrites them. */
export function buildTwinNotes(t: PvTaskNode): string {
  const lines = [`Synced from Printavo (task #${t.id})`];
  if (t.taskable) {
    if (t.taskable.__typename === "Customer") {
      lines.push(
        `Customer: https://www.printavo.com/customers/${t.taskable.id}`,
      );
    } else {
      // Quotes and invoices are the same order record in Printavo's UI —
      // both live under /invoices/{internal id}.
      lines.push(
        `${t.taskable.__typename} #${t.taskable.visualId ?? "?"}: https://www.printavo.com/invoices/${t.taskable.id}`,
      );
    }
  }
  return lines.join("\n");
}

// ── The cycle ────────────────────────────────────────────────────────────

export async function runSyncCycle(
  trigger: string,
  options: { dryRun?: boolean } = {},
): Promise<SyncSummary> {
  if (running) {
    throw new Error("A sync cycle is already running");
  }
  running = true;
  const dryRun = options.dryRun === true;
  const startedAt = new Date();
  const summary: SyncSummary = {
    trigger,
    dryRun,
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    scanned: 0,
    created: 0,
    contentUpdated: 0,
    listMoved: 0,
    skippedUnassignedOrderTasks: 0,
    suppressedLinks: 0,
    unmatchedAssigneeEmails: [],
    errors: [],
  };
  const unmatched = new Set<string>();

  try {
    // Dry run must not create the team/lists either — fall back to sentinel
    // ids (-1/-2) when they don't exist yet; routing decisions still count.
    const { assignedListId, generalListId } = dryRun
      ? await lookupPrintavoGroupReadOnly()
      : await ensurePrintavoGroup();
    const [pvTasks, memberMap, links] = await Promise.all([
      fetchAllOpenPvTasks(),
      buildMemberEmailMap(),
      hubDb.select().from(printavoTaskLinksTable),
    ]);
    summary.scanned = pvTasks.length;

    const linkByPvId = new Map<string, PrintavoTaskLink>(
      links.map((l) => [l.printavoTaskId, l]),
    );

    // Batch-load all linked moMINTum twins once.
    const mmIds = links.map((l) => l.momintumTaskId);
    const mmTasks = mmIds.length
      ? await momintumDb
          .select()
          .from(tasksTable)
          .where(inArray(tasksTable.id, mmIds))
      : [];
    const mmById = new Map(mmTasks.map((t) => [t.id, t]));

    for (const pv of pvTasks) {
      try {
        const link = linkByPvId.get(pv.id);
        if (link?.suppressed) continue;

        const desired = routePvTask(pv);
        const member = desired.assigneeEmail
          ? memberMap.get(desired.assigneeEmail)
          : undefined;
        if (desired.assigneeEmail && !member) {
          unmatched.add(desired.assigneeEmail);
        }
        // Unmatched assignee on an order task → General, unassigned (never
        // guess; never JIT-create members from sync).
        const listId =
          desired.listKind === "assigned" && member
            ? assignedListId
            : generalListId;
        const assigneeId = member?.id ?? null;
        const dueDate = pv.dueAt ? new Date(pv.dueAt) : null;

        if (!link) {
          if (!desired.createIfMissing) {
            summary.skippedUnassignedOrderTasks++;
            continue;
          }
          if (dryRun) {
            summary.created++;
            continue;
          }
          // Create twin, then link. Compensating delete on link failure so a
          // crash between the two writes can't produce duplicate mirrors.
          const [twin] = await momintumDb
            .insert(tasksTable)
            .values({
              title: desired.title,
              notes: buildTwinNotes(pv),
              listId,
              assigneeId,
              dueDate,
              source: "printavo",
              sortOrder: Date.now(),
            })
            .returning();
          if (!twin) throw new Error("insert returned no row");
          try {
            await hubDb.insert(printavoTaskLinksTable).values({
              printavoTaskId: pv.id,
              momintumTaskId: twin.id,
              origin: "printavo",
              lastSyncedCompleted: pv.completed,
              lastSyncedName: pv.name,
              lastSyncedDueAt: dueDate,
              lastSyncedAssigneeEmail: desired.assigneeEmail,
              lastSeenAt: startedAt,
            });
          } catch (linkErr) {
            await momintumDb.delete(tasksTable).where(eq(tasksTable.id, twin.id));
            throw linkErr;
          }
          summary.created++;
          continue;
        }

        // Existing link — refresh lastSeenAt and mirror content one-way
        // (Printavo → moMINTum) when Printavo's content changed since the
        // last sync. User edits in moMINTum survive until Printavo changes.
        const twin = mmById.get(link.momintumTaskId);
        if (!twin || twin.deletedAt) {
          // Twin was (soft-)deleted in moMINTum → suppress forever; never
          // touch the Printavo task from an import cycle.
          if (!dryRun) {
            await hubDb
              .update(printavoTaskLinksTable)
              .set({ suppressed: true, lastSeenAt: startedAt })
              .where(eq(printavoTaskLinksTable.id, link.id));
          }
          summary.suppressedLinks++;
          continue;
        }

        const contentChanged =
          link.lastSyncedName !== pv.name ||
          (link.lastSyncedDueAt?.getTime() ?? null) !==
            (dueDate?.getTime() ?? null) ||
          (link.lastSyncedAssigneeEmail ?? null) !==
            (desired.assigneeEmail ?? null);
        const listChanged = twin.listId !== listId;

        if (link.origin === "printavo" && (contentChanged || listChanged)) {
          if (!dryRun) {
            await momintumDb
              .update(tasksTable)
              .set({
                ...(contentChanged
                  ? { title: desired.title, dueDate, assigneeId }
                  : {}),
                ...(listChanged ? { listId } : {}),
              })
              .where(eq(tasksTable.id, twin.id));
          }
          if (contentChanged) summary.contentUpdated++;
          if (listChanged) summary.listMoved++;
        }

        if (!dryRun) {
          await hubDb
            .update(printavoTaskLinksTable)
            .set({
              lastSeenAt: startedAt,
              ...(contentChanged
                ? {
                    lastSyncedName: pv.name,
                    lastSyncedDueAt: dueDate,
                    lastSyncedAssigneeEmail: desired.assigneeEmail,
                  }
                : {}),
            })
            .where(eq(printavoTaskLinksTable.id, link.id));
        }
      } catch (err) {
        summary.errors.push(
          `task ${pv.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    summary.unmatchedAssigneeEmails = [...unmatched];
    summary.durationMs = Date.now() - startedAt.getTime();
    lastRun = summary;
    running = false;
  }
  return summary;
}
