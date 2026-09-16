/**
 * Pure auto-print configuration validation and normalization.
 *
 * Keep this module free of database imports so schedule behavior can be
 * tested offline and old app_settings rows can be upgraded on read.
 */

export const AUTO_PRINT_SCHEDULE_MODES = ["interval", "daily"] as const;
export type AutoPrintScheduleMode = (typeof AUTO_PRINT_SCHEDULE_MODES)[number];

export const DEFAULT_DAILY_TIMES = ["06:00"] as const;
export const MAX_DAILY_TIMES = 12;
export const DAILY_TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface CategoryMapping {
  /** pv_imprints type_of_work category (exact string). */
  category: string;
  /** Printavo status to move the order to after a successful print. */
  statusId: string;
  statusName: string;
}

export interface AutoPrintConfig {
  enabled: boolean;
  /** Which one schedule is active: interval or daily. */
  scheduleMode: AutoPrintScheduleMode;
  /** Hours between scheduled runs (1–24) in interval mode. */
  scheduleHours: number;
  /** Eastern local times at which daily mode may run (maximum 12). */
  dailyTimes: string[];
  /** Printavo status ids the engine pulls orders from. */
  sourceStatusIds: string[];
  /** Status set on an order when its print fails (null = leave alone). */
  errorStatusId: string | null;
  errorStatusName: string | null;
  /** PrintNode printer for workorders. */
  printerId: string | null;
  printerName: string | null;
  copies: number;
  /** Simulate runs without sending anything to PrintNode. */
  dryRun: boolean;
  /** typeOfWork category → post-print target status. */
  categoryMappings: CategoryMapping[];
}

export const DEFAULT_AUTO_PRINT_CONFIG: AutoPrintConfig = {
  enabled: false,
  scheduleMode: "interval",
  scheduleHours: 6,
  dailyTimes: [...DEFAULT_DAILY_TIMES],
  sourceStatusIds: [],
  errorStatusId: null,
  errorStatusName: null,
  printerId: null,
  printerName: null,
  copies: 1,
  dryRun: true,
  categoryMappings: [],
};

export function isAutoPrintScheduleMode(
  value: unknown,
): value is AutoPrintScheduleMode {
  return value === "interval" || value === "daily";
}

export function isDailyTime(value: unknown): value is string {
  return typeof value === "string" && DAILY_TIME_PATTERN.test(value);
}

/**
 * Normalize persisted values without allowing malformed settings to disable
 * safety defaults. Invalid/missing times use the documented 06:00 default;
 * valid values are deduplicated, sorted, and capped at the API maximum.
 */
export function normalizeDailyTimes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_DAILY_TIMES];
  const times = [
    ...new Set(value.filter((item): item is string => isDailyTime(item))),
  ].sort();
  return times.length > 0
    ? times.slice(0, MAX_DAILY_TIMES)
    : [...DEFAULT_DAILY_TIMES];
}

export function normalizeAutoPrintConfig(raw: unknown): AutoPrintConfig {
  const v = (raw ?? {}) as Partial<AutoPrintConfig>;
  const d = DEFAULT_AUTO_PRINT_CONFIG;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    scheduleMode: isAutoPrintScheduleMode(v.scheduleMode)
      ? v.scheduleMode
      : d.scheduleMode,
    scheduleHours:
      typeof v.scheduleHours === "number" &&
      Number.isInteger(v.scheduleHours) &&
      v.scheduleHours >= 1 &&
      v.scheduleHours <= 24
        ? v.scheduleHours
        : d.scheduleHours,
    dailyTimes: normalizeDailyTimes(v.dailyTimes),
    sourceStatusIds: Array.isArray(v.sourceStatusIds)
      ? v.sourceStatusIds.filter((s): s is string => typeof s === "string")
      : d.sourceStatusIds,
    errorStatusId: typeof v.errorStatusId === "string" ? v.errorStatusId : null,
    errorStatusName:
      typeof v.errorStatusName === "string" ? v.errorStatusName : null,
    printerId: typeof v.printerId === "string" ? v.printerId : null,
    printerName: typeof v.printerName === "string" ? v.printerName : null,
    copies:
      typeof v.copies === "number" &&
      Number.isInteger(v.copies) &&
      v.copies >= 1 &&
      v.copies <= 10
        ? v.copies
        : d.copies,
    dryRun: typeof v.dryRun === "boolean" ? v.dryRun : d.dryRun,
    categoryMappings: Array.isArray(v.categoryMappings)
      ? v.categoryMappings.filter(
          (m): m is CategoryMapping =>
            !!m &&
            typeof m.category === "string" &&
            m.category.length > 0 &&
            typeof m.statusId === "string" &&
            typeof m.statusName === "string",
        )
      : d.categoryMappings,
  };
}