import {
  db,
  syncRunsTable,
  syncCheckpointsTable,
  entityWatermarksTable,
  pvOrdersTable,
  pvCustomersTable,
  pvContactsTable,
  pvStatusesTable,
  changeEventsTable,
  type SyncRun,
  type SyncCheckpoint,
} from "@workspace/db";
import { and, count, desc, eq, lt } from "drizzle-orm";

export async function createRun(runType: string): Promise<SyncRun> {
  const [run] = await db
    .insert(syncRunsTable)
    .values({ runType, status: "running" })
    .returning();
  if (!run) throw new Error("Failed to create sync run");
  return run;
}

export async function findRunningRun(runType: string): Promise<SyncRun | null> {
  const [run] = await db
    .select()
    .from(syncRunsTable)
    .where(
      and(eq(syncRunsTable.runType, runType), eq(syncRunsTable.status, "running")),
    )
    .orderBy(desc(syncRunsTable.id))
    .limit(1);
  return run ?? null;
}

export async function latestRun(runType: string): Promise<SyncRun | null> {
  const [run] = await db
    .select()
    .from(syncRunsTable)
    .where(eq(syncRunsTable.runType, runType))
    .orderBy(desc(syncRunsTable.id))
    .limit(1);
  return run ?? null;
}

export async function completeRun(
  runId: number,
  stats: Record<string, unknown>,
): Promise<void> {
  await db
    .update(syncRunsTable)
    .set({ status: "completed", finishedAt: new Date(), stats })
    .where(eq(syncRunsTable.id, runId));
}

export async function failRun(runId: number, error: string): Promise<void> {
  await db
    .update(syncRunsTable)
    .set({ status: "failed", finishedAt: new Date(), error })
    .where(eq(syncRunsTable.id, runId));
}

/**
 * Mark orphaned "running" runs of a type as failed. Incremental runs
 * cannot survive a process restart (poll state is in-memory), so any
 * still marked running at boot are stale. Seed runs are excluded —
 * they are resumed via findRunningRun + checkpoints.
 * Only runs started BEFORE `bootTime` are touched, so a manual poll
 * that races the boot-time cleanup is never clobbered.
 */
export async function failOrphanedRuns(
  runType: string,
  bootTime: Date,
): Promise<number> {
  const rows = await db
    .update(syncRunsTable)
    .set({
      status: "failed",
      finishedAt: new Date(),
      error: "Orphaned: process restarted mid-run",
    })
    .where(
      and(
        eq(syncRunsTable.runType, runType),
        eq(syncRunsTable.status, "running"),
        lt(syncRunsTable.startedAt, bootTime),
      ),
    )
    .returning({ id: syncRunsTable.id });
  return rows.length;
}

export async function getOrCreateCheckpoint(
  syncRunId: number,
  entity: string,
): Promise<SyncCheckpoint> {
  const [existing] = await db
    .select()
    .from(syncCheckpointsTable)
    .where(
      and(
        eq(syncCheckpointsTable.syncRunId, syncRunId),
        eq(syncCheckpointsTable.entity, entity),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(syncCheckpointsTable)
    .values({ syncRunId, entity })
    .returning();
  if (!created) throw new Error("Failed to create sync checkpoint");
  return created;
}

export async function updateCheckpointCursor(
  syncRunId: number,
  entity: string,
  cursor: string | null,
  lastVisualId?: number | null,
): Promise<void> {
  await db
    .update(syncCheckpointsTable)
    .set({ cursor, ...(lastVisualId !== undefined ? { lastVisualId } : {}) })
    .where(
      and(
        eq(syncCheckpointsTable.syncRunId, syncRunId),
        eq(syncCheckpointsTable.entity, entity),
      ),
    );
}

export async function markCheckpointComplete(
  syncRunId: number,
  entity: string,
): Promise<void> {
  await db
    .update(syncCheckpointsTable)
    .set({ completed: true })
    .where(
      and(
        eq(syncCheckpointsTable.syncRunId, syncRunId),
        eq(syncCheckpointsTable.entity, entity),
      ),
    );
}

export async function getWatermark(entity: string): Promise<Date | null> {
  const [row] = await db
    .select()
    .from(entityWatermarksTable)
    .where(eq(entityWatermarksTable.entity, entity))
    .limit(1);
  return row?.watermark ?? null;
}

export async function setWatermark(entity: string, watermark: Date): Promise<void> {
  await db
    .insert(entityWatermarksTable)
    .values({ entity, watermark })
    .onConflictDoUpdate({
      target: entityWatermarksTable.entity,
      set: { watermark, updatedAt: new Date() },
    });
}

export async function listWatermarks(): Promise<
  Array<{ entity: string; watermark: Date }>
> {
  const rows = await db.select().from(entityWatermarksTable);
  return rows.map((r) => ({ entity: r.entity, watermark: r.watermark }));
}

export interface TableCounts {
  orders: number;
  quotes: number;
  invoices: number;
  customers: number;
  contacts: number;
  statuses: number;
  changeEvents: number;
}

export async function tableCounts(): Promise<TableCounts> {
  const [orders] = await db.select({ n: count() }).from(pvOrdersTable);
  const [quotes] = await db
    .select({ n: count() })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.orderType, "quote"));
  const [invoices] = await db
    .select({ n: count() })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.orderType, "invoice"));
  const [customers] = await db.select({ n: count() }).from(pvCustomersTable);
  const [contacts] = await db.select({ n: count() }).from(pvContactsTable);
  const [statuses] = await db.select({ n: count() }).from(pvStatusesTable);
  const [events] = await db.select({ n: count() }).from(changeEventsTable);
  return {
    orders: orders?.n ?? 0,
    quotes: quotes?.n ?? 0,
    invoices: invoices?.n ?? 0,
    customers: customers?.n ?? 0,
    contacts: contacts?.n ?? 0,
    statuses: statuses?.n ?? 0,
    changeEvents: events?.n ?? 0,
  };
}
