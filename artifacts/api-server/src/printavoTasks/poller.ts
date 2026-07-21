import type { Logger } from "pino";
import { isMomintumConfigured } from "@workspace/momintum-db";
import { printavoConfigured } from "../lib/printavoGateway";
import { isSyncRunning, runSyncCycle } from "./sync";

/**
 * Printavo ⇄ moMINTum task-sync interval poller (PT5).
 *
 * DORMANT unless PRINTAVO_TASK_SYNC_ENABLED=true. That flag must be true in
 * AT MOST ONE environment at a time (dev OR deployment, never both): each
 * environment has its own hub database — and therefore its own link table —
 * but both write twins into the SAME live moMINTum database. Two enabled
 * environments would each import every Printavo task, producing duplicate
 * twins. See replit.md.
 *
 * The manual POST /printavo-tasks/sync-now trigger is unaffected by the flag.
 */

export const TASK_SYNC_INTERVAL_MINUTES = 5;
const INTERVAL_MS = TASK_SYNC_INTERVAL_MINUTES * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let lastPollAt: Date | null = null;
let lastError: string | null = null;

export interface TaskSyncPollerInfo {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastPollAt: string | null;
  lastError: string | null;
}

export function isTaskSyncPollerEnabled(): boolean {
  return process.env["PRINTAVO_TASK_SYNC_ENABLED"] === "true";
}

export function taskSyncPollerInfo(): TaskSyncPollerInfo {
  return {
    enabled: isTaskSyncPollerEnabled(),
    running: timer !== null,
    intervalMinutes: TASK_SYNC_INTERVAL_MINUTES,
    lastPollAt: lastPollAt?.toISOString() ?? null,
    lastError,
  };
}

export function startTaskSyncPoller(logger: Logger): void {
  if (timer) return;
  if (!isTaskSyncPollerEnabled()) {
    logger.info(
      "Printavo task-sync poller disabled (PRINTAVO_TASK_SYNC_ENABLED != true) — manual sync-now only",
    );
    return;
  }
  if (!isMomintumConfigured() || !printavoConfigured()) {
    logger.warn(
      "PRINTAVO_TASK_SYNC_ENABLED=true but moMINTum DB or Printavo credentials are missing — poller not started",
    );
    return;
  }
  timer = setInterval(() => {
    void tick(logger);
  }, INTERVAL_MS);
  timer.unref();
  logger.info(
    { intervalMinutes: TASK_SYNC_INTERVAL_MINUTES },
    "Printavo task-sync poller started",
  );
}

async function tick(logger: Logger): Promise<void> {
  // Overlap guard: a manual sync-now (or a long previous cycle) may still be
  // running — skip this tick rather than queueing behind it.
  if (isSyncRunning()) {
    logger.warn("Task-sync cycle already running — skipping this tick");
    return;
  }
  try {
    const summary = await runSyncCycle("scheduler");
    lastPollAt = new Date();
    lastError = summary.errors.length > 0 ? summary.errors.join("; ") : null;
    logger.info(
      {
        durationMs: summary.durationMs,
        scanned: summary.scanned,
        created: summary.created,
        contentUpdated: summary.contentUpdated,
        listMoved: summary.listMoved,
        completedTwins: summary.completedTwins,
        reopenedTwins: summary.reopenedTwins,
        completedInPrintavo: summary.completedInPrintavo,
        reopenedInPrintavo: summary.reopenedInPrintavo,
        probed: summary.probed,
        probesDeferred: summary.probesDeferred,
        twinsDeleted: summary.twinsDeletedFromPrintavoDelete,
        errors: summary.errors.length,
      },
      "Scheduled task-sync cycle finished",
    );
  } catch (err) {
    lastPollAt = new Date();
    lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Scheduled task-sync cycle crashed");
  }
}
