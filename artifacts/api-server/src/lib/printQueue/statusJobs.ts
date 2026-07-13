import type { Logger } from "pino";
import {
  db,
  pqStatusJobsTable,
  pvOrdersTable,
  pvStatusesTable,
  type PqStatusJob,
} from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { statusUpdateMutation } from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";

/**
 * Print Queue bulk status-change jobs (PQ2).
 *
 * One background job at a time (in-memory claim slot, poPush pattern).
 * Per-order progress is persisted to pq_status_jobs.state after EVERY line
 * so a restart can never silently lose track of what was already written to
 * Printavo. Readers surface a DB-"running" job that is no longer claimed in
 * this process as interrupted (retryable).
 *
 * Every Printavo write goes through the shared throttled gateway; after a
 * successful write the local pv_orders row is updated optimistically so the
 * Print Queue reflects the move immediately (the 5-min sync reconciles).
 */

export type PqJobLineStatus = "pending" | "done" | "failed" | "stale" | "skipped";

export interface PqJobLine {
  orderId: string;
  visualId: number | null;
  nickname: string | null;
  fromStatusId: string | null;
  fromStatusName: string | null;
  targetStatusId: string;
  targetStatusName: string;
  status: PqJobLineStatus;
  error: string | null;
}

export interface PqJobState {
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  /** Set when a reader/sweeper detected the job died in a restart. */
  interrupted?: boolean;
  lines: PqJobLine[];
}

export interface PqJobDto {
  id: string;
  trigger: string;
  /** running | success | failed | interrupted (computed). */
  status: string;
  startedAt: string;
  finishedAt: string | null;
  lines: PqJobLine[];
  createdAt: string;
}

export interface PqJobLineInput {
  orderId: string;
  targetStatusId: string;
  /**
   * Stale guard — the status the user confirmed FROM. If the order's
   * current status differs at write time nothing is written for that line.
   */
  expectedStatusId: string | null;
}

const MAX_JOB_LINES = 500;

/* ── In-memory claim slot (one job at a time) ────────────────────────── */

let activeJobId: string | null = null;

function isJobActive(id: string): boolean {
  return activeJobId === id;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function readState(row: PqStatusJob): PqJobState {
  return row.state as unknown as PqJobState;
}

function toDto(row: PqStatusJob): PqJobDto {
  const state = readState(row);
  const interrupted =
    state.interrupted === true ||
    (state.status === "running" && !isJobActive(row.id));
  return {
    id: row.id,
    trigger: row.trigger,
    status: interrupted ? "interrupted" : state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    lines: state.lines,
    createdAt: row.createdAt.toISOString(),
  };
}

async function persistState(id: string, state: PqJobState): Promise<void> {
  await db
    .update(pqStatusJobsTable)
    .set({ state: state as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(pqStatusJobsTable.id, id));
}

/**
 * Mark DB-"running" jobs that are not claimed in this process as failed
 * (interrupted by a restart) so at most one job ever shows as live.
 * Unfinished lines keep their pending state — the UI offers retry.
 */
async function sweepInterruptedJobs(): Promise<void> {
  const rows = await db
    .select()
    .from(pqStatusJobsTable)
    .orderBy(desc(pqStatusJobsTable.createdAt))
    .limit(20);
  for (const row of rows) {
    const state = readState(row);
    if (state.status !== "running" || isJobActive(row.id)) continue;
    await persistState(row.id, {
      ...state,
      status: "failed",
      interrupted: true,
      finishedAt: state.finishedAt ?? new Date().toISOString(),
    });
  }
}

/* ── Start / run ─────────────────────────────────────────────────────── */

export type StartPqJobResult =
  | { status: "started"; job: PqJobDto }
  | { status: "conflict" }
  | { status: "invalid"; message: string }
  | { status: "not_configured" };

export async function startPqStatusJob(
  trigger: "manual" | "ask" | "auto",
  lineInputs: PqJobLineInput[],
  log: Logger,
): Promise<StartPqJobResult> {
  if (!printavoConfigured()) return { status: "not_configured" };
  if (lineInputs.length === 0) {
    return { status: "invalid", message: "No orders to change" };
  }
  if (lineInputs.length > MAX_JOB_LINES) {
    return { status: "invalid", message: `Maximum ${MAX_JOB_LINES} orders per job` };
  }
  const seen = new Set<string>();
  const inputs = lineInputs.filter((l) => {
    if (seen.has(l.orderId)) return false;
    seen.add(l.orderId);
    return true;
  });

  const targetIds = [...new Set(inputs.map((l) => l.targetStatusId))];
  const statusRows = await db
    .select({ id: pvStatusesTable.printavoId, name: pvStatusesTable.name })
    .from(pvStatusesTable)
    .where(inArray(pvStatusesTable.printavoId, targetIds));
  const targetNames = new Map(statusRows.map((r) => [r.id, r.name]));
  const unknown = targetIds.filter((id) => !targetNames.has(id));
  if (unknown.length > 0) {
    return { status: "invalid", message: "Unknown Printavo target status" };
  }

  const orderRows = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      visualId: pvOrdersTable.visualId,
      nickname: pvOrdersTable.nickname,
      statusId: pvOrdersTable.statusId,
      statusName: pvOrdersTable.statusName,
    })
    .from(pvOrdersTable)
    .where(inArray(pvOrdersTable.printavoId, inputs.map((l) => l.orderId)));
  const orders = new Map(orderRows.map((r) => [r.printavoId, r]));

  const lines: PqJobLine[] = inputs.map((input) => {
    const order = orders.get(input.orderId);
    const targetStatusName = targetNames.get(input.targetStatusId) as string;
    if (!order) {
      return {
        orderId: input.orderId,
        visualId: null,
        nickname: null,
        fromStatusId: null,
        fromStatusName: null,
        targetStatusId: input.targetStatusId,
        targetStatusName,
        status: "failed",
        error: "Order not found in local data",
      };
    }
    return {
      orderId: input.orderId,
      visualId: order.visualId,
      nickname: order.nickname,
      fromStatusId: order.statusId,
      fromStatusName: order.statusName,
      targetStatusId: input.targetStatusId,
      targetStatusName,
      status: "pending",
      error: null,
    };
  });

  if (activeJobId !== null) return { status: "conflict" };

  await sweepInterruptedJobs();

  const state: PqJobState = {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lines,
  };
  const [row] = await db
    .insert(pqStatusJobsTable)
    .values({ trigger, state: state as unknown as Record<string, unknown> })
    .returning();

  // Claim AFTER the insert succeeded; the claim itself is synchronous so two
  // concurrent requests cannot both pass the null check above in one tick.
  if (activeJobId !== null) {
    // Lost a race with another request between checks — mark ours failed.
    await persistState(row.id, {
      ...state,
      status: "failed",
      finishedAt: new Date().toISOString(),
    });
    return { status: "conflict" };
  }
  activeJobId = row.id;

  const expectedById = new Map(inputs.map((l) => [l.orderId, l.expectedStatusId]));
  void runJob(row.id, state, expectedById, log).catch(async (err) => {
    log.error({ err, jobId: row.id }, "pq status job crashed");
    try {
      await persistState(row.id, {
        ...state,
        status: "failed",
        finishedAt: new Date().toISOString(),
      });
    } finally {
      if (activeJobId === row.id) activeJobId = null;
    }
  });

  return { status: "started", job: toDto(row) };
}

async function runJob(
  jobId: string,
  state: PqJobState,
  expectedById: Map<string, string | null>,
  log: Logger,
): Promise<void> {
  const client = getPrintavoClient();
  try {
    for (const line of state.lines) {
      if (line.status !== "pending") continue;
      const [order] = await db
        .select({
          statusId: pvOrdersTable.statusId,
          statusName: pvOrdersTable.statusName,
        })
        .from(pvOrdersTable)
        .where(eq(pvOrdersTable.printavoId, line.orderId))
        .limit(1);
      if (!order) {
        line.status = "failed";
        line.error = "Order not found in local data";
        await persistState(jobId, state);
        continue;
      }
      if (order.statusId === line.targetStatusId) {
        line.status = "skipped";
        line.error = null;
        await persistState(jobId, state);
        continue;
      }
      const expected = expectedById.get(line.orderId) ?? null;
      if (expected && order.statusId !== expected) {
        line.status = "stale";
        line.error = `Status is now "${order.statusName ?? order.statusId}" — not changed`;
        await persistState(jobId, state);
        continue;
      }
      try {
        await client.query(statusUpdateMutation(line.orderId, line.targetStatusId));
      } catch (err) {
        line.status = "failed";
        line.error = errMessage(err);
        log.error(
          { err, jobId, orderId: line.orderId },
          "pq status job: statusUpdate failed",
        );
        await persistState(jobId, state);
        continue;
      }
      // Optimistic local update so the queue reflects the move immediately;
      // the periodic sync reconciles the full order detail.
      await db
        .update(pvOrdersTable)
        .set({ statusId: line.targetStatusId, statusName: line.targetStatusName })
        .where(eq(pvOrdersTable.printavoId, line.orderId));
      line.status = "done";
      line.error = null;
      await persistState(jobId, state);
    }
    const bad = state.lines.some((l) => l.status === "failed" || l.status === "stale");
    state.status = bad ? "failed" : "success";
    state.finishedAt = new Date().toISOString();
    await persistState(jobId, state);
    log.info(
      {
        jobId,
        done: state.lines.filter((l) => l.status === "done").length,
        failed: state.lines.filter((l) => l.status === "failed").length,
        stale: state.lines.filter((l) => l.status === "stale").length,
        skipped: state.lines.filter((l) => l.status === "skipped").length,
      },
      "pq status job finished",
    );
  } finally {
    if (activeJobId === jobId) activeJobId = null;
  }
}

/* ── Read ────────────────────────────────────────────────────────────── */

export async function getPqStatusJob(id: string): Promise<PqJobDto | null> {
  const [row] = await db
    .select()
    .from(pqStatusJobsTable)
    .where(eq(pqStatusJobsTable.id, id))
    .limit(1);
  return row ? toDto(row) : null;
}

export async function listPqStatusJobs(limit: number): Promise<PqJobDto[]> {
  const rows = await db
    .select()
    .from(pqStatusJobsTable)
    .orderBy(desc(pqStatusJobsTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 20));
  return rows.map(toDto);
}
