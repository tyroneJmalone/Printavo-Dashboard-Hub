import type { Logger } from "pino";
import { printavoConfigured } from "../printavoGateway";
import { findRunningRun, failOrphanedRuns } from "./state";
import { startOrResumeSeed } from "./seed";
import { runIncrementalPoll } from "./incremental";

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
  void resumeInterruptedSeed(logger);
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

async function resumeInterruptedSeed(logger: Logger): Promise<void> {
  if (!printavoConfigured()) return;
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
