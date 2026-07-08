import type { Logger } from "pino";
import { printavoConfigured } from "../printavoGateway";
import { findRunningRun, failOrphanedRuns } from "./state";
import { startOrResumeSeed } from "./seed";
import { startOrResumeDetailBackfill } from "./detail";
import { startOrResumePaymentsSeed } from "./payments";
import { runIncrementalPoll } from "./incremental";
import {
  isSeedActive,
  isDetailBackfillActive,
  isPaymentsSeedActive,
} from "./runState";

export const POLL_INTERVAL_MINUTES = 5;
const POLL_INTERVAL_MS = POLL_INTERVAL_MINUTES * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let lastPollAt: Date | null = null;
let lastResult: string | null = null;
let lastError: string | null = null;

export interface SchedulerInfo {
  running: boolean;
  pollIntervalMinutes: number;
  lastPollAt: string | null;
  lastResult: string | null;
  lastError: string | null;
}

export function schedulerInfo(): SchedulerInfo {
  return {
    running: timer !== null,
    pollIntervalMinutes: POLL_INTERVAL_MINUTES,
    lastPollAt: lastPollAt?.toISOString() ?? null,
    lastResult,
    lastError,
  };
}

export function startScheduler(logger: Logger): void {
  if (timer) return;
  void failOrphanedRuns("incremental", new Date())
    .then((n) => {
      if (n > 0) logger.warn({ count: n }, "Marked orphaned incremental runs failed");
    })
    .catch((err) => {
      logger.error({ err }, "Failed to clean up orphaned runs");
    });
  void resumeInterruptedRuns(logger);
  timer = setInterval(() => {
    void tick(logger);
  }, POLL_INTERVAL_MS);
  timer.unref();
  logger.info(
    { pollIntervalMinutes: POLL_INTERVAL_MINUTES },
    "Sync scheduler started",
  );
}

async function tick(logger: Logger): Promise<void> {
  try {
    await resumeInterruptedRuns(logger);
    const result = await runIncrementalPoll("scheduler", logger);
    lastPollAt = new Date();
    lastResult = result.message;
    lastError = null;
  } catch (err) {
    lastPollAt = new Date();
    lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Scheduled poll crashed");
  }
}

async function resumeInterruptedRuns(logger: Logger): Promise<void> {
  await resumeInterruptedSeed(logger);
  await resumeInterruptedDetailBackfill(logger);
  await resumeInterruptedPaymentsSeed(logger);
}

async function resumeInterruptedSeed(logger: Logger): Promise<void> {
  if (!printavoConfigured()) return;
  if (isSeedActive()) return;
  try {
    const running = await findRunningRun("seed");
    if (running) {
      logger.info({ runId: running.id }, "Found interrupted seed — resuming");
      await startOrResumeSeed(logger);
    }
  } catch (err) {
    logger.error({ err }, "Failed to check for interrupted seed");
  }
}

async function resumeInterruptedDetailBackfill(logger: Logger): Promise<void> {
  if (!printavoConfigured()) return;
  if (isDetailBackfillActive()) return;
  try {
    const running = await findRunningRun("detail_backfill");
    if (running) {
      logger.info(
        { runId: running.id },
        "Found interrupted detail backfill — resuming",
      );
      await startOrResumeDetailBackfill(logger);
    }
  } catch (err) {
    logger.error({ err }, "Failed to check for interrupted detail backfill");
  }
}

async function resumeInterruptedPaymentsSeed(logger: Logger): Promise<void> {
  if (!printavoConfigured()) return;
  if (isPaymentsSeedActive()) return;
  try {
    const running = await findRunningRun("payments_seed");
    if (running) {
      logger.info(
        { runId: running.id },
        "Found interrupted payments seed — resuming",
      );
      await startOrResumePaymentsSeed(logger);
    }
  } catch (err) {
    logger.error({ err }, "Failed to check for interrupted payments seed");
  }
}
