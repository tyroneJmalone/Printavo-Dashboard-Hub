/**
 * Pure daily auto-print schedule helpers.
 *
 * Daily schedules intentionally compare the current Eastern local minute
 * rather than calculating a UTC offset. That gives the desired DST behavior:
 * nonexistent spring-forward local times never match, while both occurrences
 * of a repeated fall-back hour share one durable local slot key.
 */

import {
  isDailyTime,
  normalizeDailyTimes,
  type AutoPrintConfig,
} from "./configValidation";

export const AUTO_PRINT_TIME_ZONE = "America/New_York";
export const AUTO_PRINT_CHECK_INTERVAL_MS = 60 * 1000;

const easternFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: AUTO_PRINT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface EasternLocalMinute {
  date: string;
  time: string;
  slotKey: string;
}

function formatterParts(date: Date): Record<string, string> {
  const parts = easternFormatter.formatToParts(date);
  return Object.fromEntries(
    parts
      .filter(
        (part): part is Intl.DateTimeFormatPart & {
          type: "year" | "month" | "day" | "hour" | "minute";
        } =>
          part.type === "year" ||
          part.type === "month" ||
          part.type === "day" ||
          part.type === "hour" ||
          part.type === "minute",
      )
      .map((part) => [part.type, part.value]),
  );
}

export function easternLocalMinute(date: Date): EasternLocalMinute {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Cannot calculate an Eastern schedule slot for an invalid date");
  }
  const parts = formatterParts(date);
  const datePart = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  return { date: datePart, time, slotKey: `${datePart}T${time}` };
}

/**
 * Returns the local slot key only when this instant is exactly one of the
 * configured schedule minutes. A slot is never caught up after its minute.
 */
export function currentDailySlotKey(
  now: Date,
  dailyTimes: readonly string[],
): string | null {
  const local = easternLocalMinute(now);
  const times = new Set(
    normalizeDailyTimes(dailyTimes).filter((time) => isDailyTime(time)),
  );
  return times.has(local.time) ? local.slotKey : null;
}

/**
 * Decide whether a daily run may start now. `lastScheduledRunAt` is read from
 * the persistent pq_print_runs row, so the same local slot is not rerun after
 * a process restart or on the repeated DST fall-back hour.
 */
export function isDailyScheduleDue(
  now: Date,
  dailyTimes: readonly string[],
  lastScheduledRunAt: Date | null,
): boolean {
  const slotKey = currentDailySlotKey(now, dailyTimes);
  if (!slotKey) return false;
  if (!lastScheduledRunAt) return true;
  /*
   * Local slot keys are ISO-sortable. During fall-back, a run at the first
   * 01:45 must consume the second occurrence's 01:30 as well as 01:45:
   * comparing only for equality would incorrectly rerun the earlier local
   * time. A later persisted slot on the same local date means this pass has
   * already progressed through that date's schedule.
   */
  return easternLocalMinute(lastScheduledRunAt).slotKey < slotKey;
}

export function isDailyMode(config: Pick<AutoPrintConfig, "scheduleMode">): boolean {
  return config.scheduleMode === "daily";
}