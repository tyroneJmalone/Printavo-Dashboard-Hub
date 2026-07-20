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
  type Task,
} from "@workspace/momintum-db";
import {
  db as hubDb,
  printavoTaskLinksTable,
  type PrintavoTaskLink,
} from "@workspace/db";
import {
  tasksPageQuery,
  taskDetailQuery,
  taskUpdateMutation,
  PrintavoApiError,
} from "@workspace/printavo";
import { getPrintavoClient } from "../lib/printavoGateway";
import { setTaskCompletion } from "../momintum/taskCompletion";

/**
 * Printavo ⇄ moMINTum task sync engine.
 *
 * PHASE 3 SCOPE (current): import (Printavo → moMINTum, one-way content
 * mirror) + TWO-WAY COMPLETION. Completion reconciliation is a boolean 3-way
 * compare per link — moMINTum state vs Printavo state vs last-synced baseline.
 * Exactly one side can differ from the baseline (a both-changed boolean always
 * converges to agreement), so the side that changed wins and is mirrored to
 * the other. Completing a twin pushes `taskUpdate {completed:true}` to
 * Printavo (merge semantics, live-verified: other fields survive).
 *
 * Links whose Printavo task vanished from the open scan are PROBED
 * individually (capped per cycle to protect the shared rate limit):
 * completed in Printavo → complete the twin; deleted in Printavo → soft-delete
 * the twin + drop the link. Settled pairs (both sides completed) are never
 * probed again. Send-to-Printavo (creating Printavo tasks) is a later phase.
 *
 * Ownership rules (see replit.md):
 * - moMINTum DB is the standalone app's LIVE prod DB — data-row writes only,
 *   never schema changes, never members.clerk_user_id, no JIT member
 *   creation from sync (unmatched assignee emails route to the shared lists
 *   as if unassigned).
 * - The link table lives in the HUB's own DB (@workspace/db).
 * - All Printavo traffic goes through the shared throttled gateway.
 */

/** Shared with momintum/tasks.ts: identifies the Printavo team whose shared
 *  lists are quarantined from date/overview task queries. */
export const PRINTAVO_TEAM_NAME = "Printavo";
const TEAM_NAME = PRINTAVO_TEAM_NAME;
const GENERAL_LIST_NAME = "General";
const PRODUCTION_LIST_NAME = "Production";
const TEAM_COLOR = "#16a34a";
const GENERAL_LIST_COLOR = "#2baeae";
const PRODUCTION_LIST_COLOR = "#f59e0b";
const ENSURE_LOCK_KEY = "momintum:printavo-task-sync:ensure";

// ── Printavo response shapes (fields per tasksPageQuery) ────────────────

interface PvUser {
  id: string;
  name: string | null;
  email: string | null;
}

export interface PvTaskable {
  __typename: "Invoice" | "Quote" | "Customer";
  id: string;
  visualId?: number | string | null;
  /** Invoice/Quote only (order nickname). */
  nickname?: string | null;
  /** Invoice/Quote only. */
  contact?: {
    fullName: string | null;
    customer?: { companyName: string | null } | null;
  } | null;
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
  /** Customer-tied tasks without a matched assignee — mirror-only, never created fresh. */
  skippedCustomerTasks: number;
  suppressedLinks: number;
  /** Twins completed because their Printavo task completed. */
  completedTwins: number;
  /** Twins reopened because their Printavo task was reopened. */
  reopenedTwins: number;
  /** Printavo tasks completed because their twin was completed in moMINTum. */
  completedInPrintavo: number;
  /** Printavo tasks reopened because their twin was reopened in moMINTum. */
  reopenedInPrintavo: number;
  /** Individual task(id) probes for links missing from the open scan. */
  probed: number;
  /** Probe candidates deferred to the next cycle (per-cycle cap). */
  probesDeferred: number;
  /** Twins soft-deleted because the Printavo task was deleted. */
  twinsDeletedFromPrintavoDelete: number;
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
 * JIT-ensure the "Printavo" team plus its two shared lists (General +
 * Production). Advisory-locked: neither teams.name nor lists.name is unique
 * in the standalone schema, so concurrent ensures would create duplicates.
 * Lists are created with ownerId=null (shared → visible to everyone) and
 * teamId set (badge only).
 *
 * Group memberships: when the GROUP is first created, all ensured lists are
 * attached; when it already exists, only lists created in THIS call are
 * attached. Pre-existing lists are never re-attached — if Tyler ungroups or
 * moves them, the sync must not undo that.
 */
export async function ensurePrintavoGroup(): Promise<{
  generalListId: number;
  productionListId: number;
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

    const ensureList = async (
      name: string,
      color: string,
    ): Promise<{ id: number; created: boolean }> => {
      const [existing] = await tx
        .select()
        .from(listsTable)
        .where(sql`${listsTable.name} = ${name} AND ${listsTable.teamId} = ${team.id} AND ${listsTable.ownerId} IS NULL`)
        .orderBy(asc(listsTable.id))
        .limit(1);
      if (existing) return { id: existing.id, created: false };
      const [created] = await tx
        .insert(listsTable)
        .values({ name, color, teamId: team.id, ownerId: null })
        .returning();
      if (!created) throw new Error(`Failed to ensure list ${name}`);
      return { id: created.id, created: true };
    };

    const general = await ensureList(GENERAL_LIST_NAME, GENERAL_LIST_COLOR);
    const production = await ensureList(
      PRODUCTION_LIST_NAME,
      PRODUCTION_LIST_COLOR,
    );

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
            { listId: general.id, groupId: group.id },
            { listId: production.id, groupId: group.id },
          ])
          .onConflictDoNothing();
      }
    } else {
      const newlyCreated = [general, production].filter((l) => l.created);
      if (newlyCreated.length > 0) {
        await tx
          .insert(listGroupMembershipsTable)
          .values(
            newlyCreated.map((l) => ({
              listId: l.id,
              groupId: existingGroup.id,
            })),
          )
          .onConflictDoNothing();
      }
    }

    return { generalListId: general.id, productionListId: production.id };
  });
}

/** Read-only lookup for dry runs; sentinels when the group doesn't exist. */
async function lookupPrintavoGroupReadOnly(): Promise<{
  generalListId: number;
  productionListId: number;
}> {
  const [team] = await momintumDb
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.name, TEAM_NAME))
    .orderBy(asc(teamsTable.id))
    .limit(1);
  if (!team) return { generalListId: -2, productionListId: -3 };
  const lists = await momintumDb
    .select()
    .from(listsTable)
    .where(eq(listsTable.teamId, team.id))
    .orderBy(asc(listsTable.id));
  return {
    generalListId:
      lists.find((l) => l.name === GENERAL_LIST_NAME && !l.ownerId)?.id ?? -2,
    productionListId:
      lists.find((l) => l.name === PRODUCTION_LIST_NAME && !l.ownerId)?.id ??
      -3,
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

export type TwinListKind = "private" | "general" | "production";

interface DesiredMirror {
  /** Where the twin belongs. "private" = listId NULL + assigneeId set —
   *  visible only in the assignee's own views (and to admins). */
  listKind: TwinListKind;
  title: string;
  assigneeEmail: string | null;
  /** False for customer-tied tasks without a matched assignee: mirror only
   *  if a link already exists, never create fresh. */
  createIfMissing: boolean;
}

/** Tyler's routing spec (rev. 2026-07-20):
 *  - assignee email matched to a moMINTum member → PRIVATE (no shared list),
 *    whether or not the task is order-tied;
 *  - no assignee (or unmatched email — never guess, never JIT-create members
 *    from sync) + invoice/quote-tied → shared "Production" list;
 *  - no assignee + not order-tied → shared "General" list;
 *  - customer-tied tasks without a matched assignee keep the historical
 *    mirror-only behavior (General, never created fresh) — zero open ones
 *    exist as of this revision. */
export function routePvTask(
  t: PvTaskNode,
  memberMatched: boolean,
): DesiredMirror {
  const email = t.assignedTo?.email?.trim().toLowerCase() || null;
  const orderTied =
    t.taskable?.__typename === "Invoice" || t.taskable?.__typename === "Quote";
  const suffix = !t.taskable
    ? ""
    : t.taskable.__typename === "Customer"
      ? " (customer task)"
      : ` (INV #${t.taskable.visualId ?? "?"})`;
  const listKind: TwinListKind =
    email && memberMatched ? "private" : orderTied ? "production" : "general";
  return {
    listKind,
    title: `${t.name}${suffix}`,
    assigneeEmail: email,
    createIfMissing:
      t.taskable?.__typename === "Customer"
        ? Boolean(email && memberMatched)
        : true,
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
      lines.push(...buildOrderInfoLines(t.taskable));
    }
  }
  return lines.join("\n");
}

/** Customer / company / order-nickname lines for invoice- and quote-tied
 *  twins (blank fields skipped). Exported for the one-time notes backfill. */
export function buildOrderInfoLines(taskable: PvTaskable): string[] {
  const lines: string[] = [];
  const contactName = taskable.contact?.fullName?.trim();
  const company = taskable.contact?.customer?.companyName?.trim();
  const nickname = taskable.nickname?.trim();
  if (contactName) lines.push(`Customer: ${contactName}`);
  if (company) lines.push(`Company: ${company}`);
  if (nickname) lines.push(`Nickname: ${nickname}`);
  return lines;
}

// ── Two-way completion ───────────────────────────────────────────────────

/**
 * Boolean 3-way completion reconcile for one link (moMINTum vs Printavo vs
 * last-synced baseline). With a boolean, at most ONE side can disagree with
 * the baseline while the pair disagrees with each other — that side changed,
 * and its state is mirrored to the other side. Performs the side-writes but
 * NOT the link-row update; returns the new baseline for the caller to persist.
 */
async function reconcileCompletion(opts: {
  pvTaskId: string;
  pvCompleted: boolean;
  twin: Task;
  link: PrintavoTaskLink;
  dryRun: boolean;
  summary: SyncSummary;
}): Promise<boolean> {
  const { pvTaskId, pvCompleted, twin, link, dryRun, summary } = opts;
  if (twin.completed === pvCompleted) return pvCompleted;

  if (twin.completed !== link.lastSyncedCompleted) {
    // moMINTum changed → push to Printavo. taskUpdate has MERGE semantics
    // (live-verified): sending only {completed} preserves all other fields.
    if (!dryRun) {
      await getPrintavoClient().query(
        taskUpdateMutation(pvTaskId, { completed: twin.completed }),
      );
    }
    if (twin.completed) summary.completedInPrintavo++;
    else summary.reopenedInPrintavo++;
    return twin.completed;
  }

  // Printavo changed → mirror to the twin via the shared completion helper
  // (completedAt stamping + recurring respawn — never bypassed).
  if (!dryRun) await setTaskCompletion(twin.id, pvCompleted);
  if (pvCompleted) summary.completedTwins++;
  else summary.reopenedTwins++;
  return pvCompleted;
}

/**
 * Conservative not-found detection for task(id) probes. Deleting a twin is
 * destructive — only an EXPLICIT not-found may trigger it; any other error
 * (network, rate limit, 5xx) is logged and retried next cycle.
 * Live-verified 2026-07-19: querying a deleted task throws a GraphQL error
 * "Task: Field id with value <id>: Not found" (data.task is NOT null).
 */
function isNotFoundError(err: PrintavoApiError): boolean {
  return /not\s*found|does\s*not\s*exist|couldn'?t\s*find/i.test(err.message);
}

/** Per-cycle cap on individual task(id) probes — protects the account-wide
 *  Printavo rate limit (10 req/5s, shared). Leftovers run next cycle. */
const PROBE_CAP = 25;

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
    skippedCustomerTasks: 0,
    suppressedLinks: 0,
    completedTwins: 0,
    reopenedTwins: 0,
    completedInPrintavo: 0,
    reopenedInPrintavo: 0,
    probed: 0,
    probesDeferred: 0,
    twinsDeletedFromPrintavoDelete: 0,
    unmatchedAssigneeEmails: [],
    errors: [],
  };
  const unmatched = new Set<string>();

  try {
    // Dry run must not create the team/lists either — fall back to sentinel
    // ids (-2/-3) when they don't exist yet; routing decisions still count.
    const { generalListId, productionListId } = dryRun
      ? await lookupPrintavoGroupReadOnly()
      : await ensurePrintavoGroup();
    const [pvTasks, memberMap] = await Promise.all([
      fetchAllOpenPvTasks(),
      buildMemberEmailMap(),
    ]);
    // Links are read AFTER the (multi-second) Printavo scan on purpose: a
    // send-to-Printavo that lands mid-scan is then still visible in the link
    // map, shrinking the double-twin race window to ~ms. (The unique indexes
    // + compensating deletes make the residual race self-healing anyway.)
    const links = await hubDb.select().from(printavoTaskLinksTable);
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

        const email = pv.assignedTo?.email?.trim().toLowerCase() || null;
        const member = email ? memberMap.get(email) : undefined;
        if (email && !member) unmatched.add(email);
        const desired = routePvTask(pv, Boolean(member));
        const listId =
          desired.listKind === "private"
            ? null
            : desired.listKind === "production"
              ? productionListId
              : generalListId;
        const assigneeId = member?.id ?? null;
        const dueDate = pv.dueAt ? new Date(pv.dueAt) : null;

        if (!link) {
          if (!desired.createIfMissing) {
            summary.skippedCustomerTasks++;
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
              lastSyncedListKind: desired.listKind,
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

        const assigneeEmailChanged =
          (link.lastSyncedAssigneeEmail ?? null) !==
          (desired.assigneeEmail ?? null);
        const contentChanged =
          link.lastSyncedName !== pv.name ||
          (link.lastSyncedDueAt?.getTime() ?? null) !==
            (dueDate?.getTime() ?? null) ||
          assigneeEmailChanged;
        // List placement is (re-)applied only when the ROUTING changed:
        // kind changed, assignee changed (a Printavo reassignment A→B must
        // re-home the task even though the kind stays "private"), or the
        // NULL baseline (pre-overhaul link → one-time migration). Otherwise
        // a user's manual re-listing wins — the sync must not yank a private
        // task back out of a personal list every cycle.
        const routingChanged =
          link.lastSyncedListKind === null ||
          link.lastSyncedListKind !== desired.listKind ||
          assigneeEmailChanged;
        const listChanged = routingChanged && twin.listId !== listId;

        if (link.origin === "printavo" && (contentChanged || listChanged)) {
          if (!dryRun) {
            await momintumDb
              .update(tasksTable)
              .set({
                ...(contentChanged
                  ? { title: desired.title, dueDate, assigneeId }
                  : {}),
                // assigneeId must ride along with every list move: a
                // matched-status flip (member row added/removed for an
                // unchanged email) changes routing WITHOUT changing the
                // assignee email, so contentChanged stays false — without
                // this, a production→private move would leave the twin
                // list-less AND assignee-less (invisible), and the reverse
                // would leave a stale assignee on a shared-list task.
                ...(listChanged ? { listId, assigneeId } : {}),
              })
              .where(eq(tasksTable.id, twin.id));
          }
          if (contentChanged) summary.contentUpdated++;
          if (listChanged) summary.listMoved++;
        }

        // Two-way completion (open scan ⇒ pv.completed is false): a twin
        // completed since the baseline pushes to Printavo; a twin that is
        // completed WITH baseline=true means Printavo reopened → reopen twin.
        const newCompletedBaseline = await reconcileCompletion({
          pvTaskId: pv.id,
          pvCompleted: pv.completed,
          twin,
          link,
          dryRun,
          summary,
        });

        if (!dryRun) {
          await hubDb
            .update(printavoTaskLinksTable)
            .set({
              lastSeenAt: startedAt,
              lastSyncedCompleted: newCompletedBaseline,
              ...(link.origin === "printavo"
                ? { lastSyncedListKind: desired.listKind }
                : {}),
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

    // ── Vanished-task probes ─────────────────────────────────────────────
    // Links whose Printavo task was NOT in the open scan: it was either
    // completed or deleted in Printavo — only an individual task(id) probe
    // can tell which. Settled pairs (both sides completed) are skipped
    // forever; the per-cycle cap defers the rest to the next cycle.
    const seenPvIds = new Set(pvTasks.map((t) => t.id));
    const client = getPrintavoClient();
    for (const link of links) {
      if (link.suppressed || seenPvIds.has(link.printavoTaskId)) continue;
      try {
        const twin = mmById.get(link.momintumTaskId);
        if (!twin || twin.deletedAt) {
          // Twin (soft-)deleted in moMINTum → suppress, same as the open path.
          if (!dryRun) {
            await hubDb
              .update(printavoTaskLinksTable)
              .set({ suppressed: true })
              .where(eq(printavoTaskLinksTable.id, link.id));
          }
          summary.suppressedLinks++;
          continue;
        }
        if (link.lastSyncedCompleted && twin.completed) continue;
        if (summary.probed >= PROBE_CAP) {
          summary.probesDeferred++;
          continue;
        }
        summary.probed++;

        let pv: PvTaskNode | null;
        try {
          const data = await client.query<{ task: PvTaskNode | null }>(
            taskDetailQuery(link.printavoTaskId),
          );
          pv = data.task;
        } catch (err) {
          if (err instanceof PrintavoApiError && isNotFoundError(err)) {
            pv = null;
          } else {
            throw err; // transient — logged below, retried next cycle
          }
        }

        if (!pv) {
          // Deleted in Printavo → soft-delete the twin (restorable from the
          // standalone app's trash) and drop the link.
          if (!dryRun) {
            await momintumDb
              .update(tasksTable)
              .set({ deletedAt: new Date() })
              .where(eq(tasksTable.id, twin.id));
            await hubDb
              .delete(printavoTaskLinksTable)
              .where(eq(printavoTaskLinksTable.id, link.id));
          }
          summary.twinsDeletedFromPrintavoDelete++;
          continue;
        }

        const newBaseline = await reconcileCompletion({
          pvTaskId: link.printavoTaskId,
          pvCompleted: pv.completed,
          twin,
          link,
          dryRun,
          summary,
        });
        if (!dryRun && newBaseline !== link.lastSyncedCompleted) {
          await hubDb
            .update(printavoTaskLinksTable)
            .set({ lastSyncedCompleted: newBaseline })
            .where(eq(printavoTaskLinksTable.id, link.id));
        }
      } catch (err) {
        summary.errors.push(
          `probe ${link.printavoTaskId}: ${err instanceof Error ? err.message : String(err)}`,
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
