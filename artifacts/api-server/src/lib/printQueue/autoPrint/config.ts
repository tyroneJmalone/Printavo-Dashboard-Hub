import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

export interface CategoryMapping {
  /** pv_imprints type_of_work category (exact string). */
  category: string;
  /** Printavo status to move the order to after a successful print. */
  statusId: string;
  statusName: string;
}

export interface AutoPrintConfig {
  enabled: boolean;
  /** Hours between scheduled runs (1–24). */
  scheduleHours: number;
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
  scheduleHours: 6,
  sourceStatusIds: [],
  errorStatusId: null,
  errorStatusName: null,
  printerId: null,
  printerName: null,
  copies: 1,
  dryRun: true,
  categoryMappings: [],
};

function normalize(raw: unknown): AutoPrintConfig {
  const v = (raw ?? {}) as Partial<AutoPrintConfig>;
  const d = DEFAULT_AUTO_PRINT_CONFIG;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    scheduleHours:
      typeof v.scheduleHours === "number" &&
      Number.isInteger(v.scheduleHours) &&
      v.scheduleHours >= 1 &&
      v.scheduleHours <= 24
        ? v.scheduleHours
        : d.scheduleHours,
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

export async function getAutoPrintConfig(): Promise<AutoPrintConfig> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, CONFIG_KEY))
    .limit(1);
  return normalize(rows[0]?.value);
}

export async function setAutoPrintConfig(
  raw: unknown,
): Promise<AutoPrintConfig> {
  const value = normalize(raw);
  await db
    .insert(appSettingsTable)
    .values({ key: CONFIG_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
  return value;
}
