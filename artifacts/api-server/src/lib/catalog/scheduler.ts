import type { Logger } from "pino";
import { db, catalogRefreshRunsTable } from "@workspace/db";
import { desc, eq, and } from "drizzle-orm";
import { runCatalogRefresh, isRefreshActive, failOrphanedCatalogRuns } from "./refresh";

/**
 * Nightly catalog refresh scheduler (same shape as the auto-print scheduler:
 * idempotent start, unref'd interval, guarded async tick). Runs the full
 * vendor import + tagging once per night inside a 1–6 AM Chicago window,
 * gated on "no successful vendor run in the last 20h" so a manual daytime
 * refresh naturally skips that night's run.
 */

const TICK_MS = 15 * 60 * 1000;
const FRESH_MS = 20 * 60 * 60 * 1000;
/** Boot catch-up: a vendor with no success in this long gets refreshed at
 * startup instead of waiting for the nightly window. A dev workspace is
 * usually asleep at 1–6 AM, so the window alone can starve a vendor forever
 * (SanMar sat at a partial import for days this way). */
const BOOT_STALE_MS = 26 * 60 * 60 * 1000;

const VENDORS = ["ss", "sanmar"] as const;
type Vendor = (typeof VENDORS)[number];

let started = false;

function chicagoHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date()),
  );
}

/** Per-vendor last successful run. One vendor's success must never mask the
 * other vendor's failed/missing import. */
async function staleVendors(maxAgeMs: number): Promise<Vendor[]> {
  const stale: Vendor[] = [];
  for (const vendor of VENDORS) {
    const [row] = await db
      .select({ finishedAt: catalogRefreshRunsTable.finishedAt })
      .from(catalogRefreshRunsTable)
      .where(and(eq(catalogRefreshRunsTable.status, "completed"), eq(catalogRefreshRunsTable.vendor, vendor)))
      .orderBy(desc(catalogRefreshRunsTable.finishedAt))
      .limit(1);
    const last = row?.finishedAt ?? null;
    if (!last || Date.now() - last.getTime() > maxAgeMs) stale.push(vendor);
  }
  return stale;
}

export function startCatalogScheduler(log: Logger): void {
  if (started) return;
  started = true;
  // Boot: clean up orphans, then catch up any vendor whose last successful
  // import is missing or stale (covers both the very first seed and imports
  // killed mid-run by a restart).
  void (async () => {
    try {
      await failOrphanedCatalogRuns();
      const vendors = await staleVendors(BOOT_STALE_MS);
      if (vendors.length > 0) {
        log.info({ vendors }, "catalog stale at boot — starting catch-up import");
        await runCatalogRefresh({ trigger: "seed", vendors: [...vendors] }, log);
      }
    } catch (err) {
      log.warn({ err }, "catalog boot check failed");
    }
  })();
  const tick = async () => {
    try {
      if (isRefreshActive()) return;
      const hour = chicagoHour();
      if (hour < 1 || hour >= 6) return;
      const vendors = await staleVendors(FRESH_MS);
      if (vendors.length === 0) return;
      log.info({ vendors }, "starting nightly catalog refresh");
      await runCatalogRefresh({ trigger: "scheduler", vendors: [...vendors] }, log);
    } catch (err) {
      log.error({ err }, "catalog scheduler tick failed");
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}
