import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_AUTO_PRINT_CONFIG,
  normalizeAutoPrintConfig,
  type AutoPrintConfig,
} from "./configValidation";

export {
  AUTO_PRINT_SCHEDULE_MODES,
  DAILY_TIME_PATTERN,
  DEFAULT_AUTO_PRINT_CONFIG,
  DEFAULT_DAILY_TIMES,
  MAX_DAILY_TIMES,
  isAutoPrintScheduleMode,
  isDailyTime,
  normalizeAutoPrintConfig,
  normalizeDailyTimes,
} from "./configValidation";
export type {
  AutoPrintConfig,
  AutoPrintScheduleMode,
  CategoryMapping,
} from "./configValidation";

/**
 * Auto-print (PQ3a) configuration — single app_settings row, editable from
 * the Hub UI. Follows the vendorSettings pattern.
 *
 * SAFETY DEFAULTS: enabled=false AND dryRun=true. Both must be flipped
 * deliberately before anything physically prints. The PQ2 master switch
 * (pq_automation_enabled) does NOT gate auto-print — this config's own
 * `enabled` flag does.
 */

const CONFIG_KEY = "pq_autoprint_config";

export async function getAutoPrintConfig(): Promise<AutoPrintConfig> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, CONFIG_KEY))
    .limit(1);
  return normalizeAutoPrintConfig(rows[0]?.value);
}

export async function setAutoPrintConfig(
  raw: unknown,
): Promise<AutoPrintConfig> {
  const value = normalizeAutoPrintConfig(raw);
  await db
    .insert(appSettingsTable)
    .values({ key: CONFIG_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
  return value;
}
