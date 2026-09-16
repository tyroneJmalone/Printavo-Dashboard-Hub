import type { Logger } from "pino";
import { getAutoPrintConfig } from "./config";
import {
  startAutoPrintRun,
  anyRunActive,
  lastRunStartedAt,
  lastScheduledRunStartedAt,
} from "./engine";
import { scheduledAutoPrintAllowed } from "./schedulerSafety";
import {
  AUTO_PRINT_CHECK_INTERVAL_MS,
  isDailyScheduleDue,
} from "./scheduleUtils";

export { scheduledAutoPrintAllowed } from "./schedulerSafety";
export {
  AUTO_PRINT_CHECK_INTERVAL_MS,
  AUTO_PRINT_TIME_ZONE,
  currentDailySlotKey,
  easternLocalMinute,
  isDailyMode,
  isDailyScheduleDue,
} from "./scheduleUtils";

/**
 * Auto-print scheduler (PQ3a). Separate from the sync scheduler — checks
 * every minute. Interval mode retains the original "last run older than
 * scheduleHours" behavior. Daily mode considers only the current Eastern
 * local minute and never catches up an older slot. The engine's own claim
 * slot and validations do the rest; the config's dryRun flag applies to
 * scheduled runs exactly as manual ones.
 */

let timer: NodeJS.Timeout | null = null;
let devLiveScheduleWarningLogged = false;

export function startAutoPrintScheduler(logger: Logger): void {
  if (timer) return;
  timer = setInterval(() => {
    void checkDue(logger);
  }, AUTO_PRINT_CHECK_INTERVAL_MS);
  timer.unref();
  logger.info("Auto-print scheduler started");
}

async function checkDue(logger: Logger): Promise<void> {
  try {
    const config = await getAutoPrintConfig();
    if (!config.enabled) return;
    /*
     * Development shares the live database and PrintNode credentials. A
     * development scheduler must never autonomously submit a live job,
     * regardless of the persisted config (which may intentionally be live in
     * production). Dry-run schedules remain useful for exercising discovery
     * and PDF generation. Manual runs intentionally keep their existing
     * explicit-control behavior in startAutoPrintRun.
     */
    if (!scheduledAutoPrintAllowed(config.dryRun)) {
      if (!devLiveScheduleWarningLogged) {
        logger.warn(
          "Scheduled live auto-print is disabled in development; set dryRun=true for scheduled checks",
        );
        devLiveScheduleWarningLogged = true;
      }
      return;
    }
    devLiveScheduleWarningLogged = false;
    if (anyRunActive()) return;
    if (config.scheduleMode === "daily") {
      const last = await lastScheduledRunStartedAt();
      if (!isDailyScheduleDue(new Date(), config.dailyTimes, last)) return;
    } else {
      const last = await lastRunStartedAt();
      const dueAt = last
        ? last.getTime() + config.scheduleHours * 60 * 60 * 1000
        : 0;
      if (Date.now() < dueAt) return;
    }
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
