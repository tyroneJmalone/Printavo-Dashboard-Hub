import type { Logger } from "pino";
import { db, catalogRefreshRunsTable } from "@workspace/db";
import { desc, eq, and, inArray } from "drizzle-orm";
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

let started = false;

function chicagoHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date()),
  );
}

async function lastSuccessfulVendorRunAt(): Promise<Date | null> {
  const [row] = await db
    .select({ finishedAt: catalogRefreshRunsTable.finishedAt })
    .from(catalogRefreshRunsTable)
    .where(and(eq(catalogRefreshRunsTable.status, "completed"), inArray(catalogRefreshRunsTable.vendor, ["ss", "sanmar"])))
    .orderBy(desc(catalogRefreshRunsTable.finishedAt))
    .limit(1);
  return row?.finishedAt ?? null;
}

export function startCatalogScheduler(log: Logger): void {
  if (started) return;
  started = true;
  // Boot: clean up orphans, then bootstrap the very first import immediately
  // (an empty catalog shouldn't wait for tonight's window).
  void (async () => {
    try {
      await failOrphanedCatalogRuns();
      const last = await lastSuccessfulVendorRunAt();
      if (!last) {
        log.info("no successful catalog import yet — starting initial seed");
        await runCatalogRefresh({ trigger: "seed" }, log);
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
      const last = await lastSuccessfulVendorRunAt();
      if (last && Date.now() - last.getTime() < FRESH_MS) return;
      log.info("starting nightly catalog refresh");
      await runCatalogRefresh({ trigger: "scheduler" }, log);
    } catch (err) {
      log.error({ err }, "catalog scheduler tick failed");
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}
