import type { Logger } from "pino";
import { getAutoPrintConfig } from "./config";
import { startAutoPrintRun, anyRunActive, lastRunStartedAt } from "./engine";

/**
 * Auto-print scheduler (PQ3a). Separate from the sync scheduler — checks
 * every 5 minutes whether a run is due (enabled && last run older than
 * scheduleHours). The engine's own claim slot and validations do the rest;
 * the config's dryRun flag applies to scheduled runs exactly as manual ones.
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startAutoPrintScheduler(logger: Logger): void {
  if (timer) return;
  timer = setInterval(() => {
    void checkDue(logger);
  }, CHECK_INTERVAL_MS);
  timer.unref();
  logger.info("Auto-print scheduler started");
}

async function checkDue(logger: Logger): Promise<void> {
  try {
    const config = await getAutoPrintConfig();
    if (!config.enabled) return;
    if (anyRunActive()) return;
    const last = await lastRunStartedAt();
    const dueAt = last
      ? last.getTime() + config.scheduleHours * 60 * 60 * 1000
      : 0;
    if (Date.now() < dueAt) return;
    const result = await startAutoPrintRun("scheduled", {}, logger);
    if (result.status === "started") {
      logger.info(
        { runId: result.run.id, dryRun: result.run.dryRun },
        "Auto-print scheduled run started",
      );
    }
  } catch (err) {
    logger.error({ err }, "Auto-print due check crashed");
  }
}
