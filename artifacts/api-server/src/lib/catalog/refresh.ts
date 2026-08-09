import { db, catalogRefreshRunsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { SanMarClient } from "@workspace/sanmar";
import { SSClient } from "@workspace/ss-activewear";
import type { Logger } from "pino";
import { importSSCatalog, importSanMarCatalog, type ImportCounts } from "./importers";
import { runTaggingPass } from "./tagger";

/**
 * Catalog refresh orchestrator. Each vendor import and the AI tagging pass
 * are recorded as separate catalog_refresh_runs rows so the health panel can
 * show exactly which piece failed. One vendor being down never blocks the
 * other. Only one refresh runs at a time (in-process guard — this server is
 * a single instance).
 */

function sanmarClient(): SanMarClient {
  const customerNumber = process.env.SANMAR_ACCOUNT_NUMBER;
  const username = process.env.SANMAR_USERNAME;
  const password = process.env.SANMAR_PASSWORD;
  if (!customerNumber || !username || !password) throw new Error("SanMar credentials are not configured");
  return new SanMarClient({ customerNumber, username, password });
}

function ssClient(): SSClient {
  const accountNumber = process.env.SS_ACCOUNT_NUMBER;
  const apiKey = process.env.SS_API_KEY;
  if (!accountNumber || !apiKey) throw new Error("S&S Activewear credentials are not configured");
  return new SSClient({ accountNumber, apiKey });
}

let refreshActive = false;
export function isRefreshActive(): boolean {
  return refreshActive;
}

async function createRun(vendor: string, trigger: string): Promise<number> {
  const [row] = await db
    .insert(catalogRefreshRunsTable)
    .values({ vendor, trigger, status: "running" })
    .returning({ id: catalogRefreshRunsTable.id });
  return row!.id;
}

async function completeRun(id: number, counts: Partial<ImportCounts> & { colorsTagged?: number; productsTagged?: number }) {
  await db
    .update(catalogRefreshRunsTable)
    .set({
      status: "completed",
      finishedAt: new Date(),
      productsUpserted: counts.productsUpserted ?? 0,
      colorsUpserted: counts.colorsUpserted ?? 0,
      discontinuedCount: counts.discontinuedCount ?? 0,
      colorsTagged: counts.colorsTagged ?? 0,
      productsTagged: counts.productsTagged ?? 0,
    })
    .where(eq(catalogRefreshRunsTable.id, id));
}

async function failRun(id: number, err: unknown) {
  await db
    .update(catalogRefreshRunsTable)
    .set({
      status: "failed",
      finishedAt: new Date(),
      error: err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000),
    })
    .where(eq(catalogRefreshRunsTable.id, id));
}

export interface RefreshOptions {
  trigger: "scheduler" | "manual" | "seed";
  vendors?: ("sanmar" | "ss")[]; // default both
  skipTagging?: boolean;
}

export async function runCatalogRefresh(opts: RefreshOptions, log: Logger): Promise<void> {
  if (refreshActive) {
    log.warn("catalog refresh already active — skipping");
    return;
  }
  refreshActive = true;
  const vendors = opts.vendors ?? ["ss", "sanmar"];
  try {
    for (const vendor of vendors) {
      const runId = await createRun(vendor, opts.trigger);
      try {
        const counts =
          vendor === "ss"
            ? await importSSCatalog(ssClient(), log)
            : await importSanMarCatalog(sanmarClient(), log);
        await completeRun(runId, counts);
      } catch (err) {
        log.error({ err, vendor }, "catalog vendor import failed");
        await failRun(runId, err);
      }
    }
    if (!opts.skipTagging) {
      const runId = await createRun("tagging", opts.trigger);
      try {
        const counts = await runTaggingPass(log);
        await completeRun(runId, counts);
      } catch (err) {
        log.error({ err }, "catalog tagging pass failed");
        await failRun(runId, err);
      }
    }
  } finally {
    refreshActive = false;
  }
}

/** At boot, runs orphaned by a restart must not look forever-running. */
export async function failOrphanedCatalogRuns(): Promise<void> {
  await db
    .update(catalogRefreshRunsTable)
    .set({ status: "failed", finishedAt: new Date(), error: "orphaned by server restart" })
    .where(eq(catalogRefreshRunsTable.status, "running"));
}

/** Health snapshot for the panel. */
export async function catalogHealth() {
  const [counts] = (
    (await db.execute(sql`
      SELECT
        (SELECT count(*) FROM catalog_products WHERE discontinued = false) AS active_products,
        (SELECT count(*) FROM catalog_products WHERE discontinued = true) AS discontinued_products,
        (SELECT count(*) FROM catalog_colors) AS colors,
        (SELECT count(*) FROM catalog_color_families WHERE families <> '{}') AS colors_tagged,
        (SELECT count(*) FROM catalog_products WHERE tags <> '{}' AND discontinued = false) AS products_tagged,
        (SELECT count(*) FROM catalog_tag_overrides) AS tag_overrides,
        (SELECT count(*) FROM catalog_color_families WHERE source = 'staff') AS staff_color_fixes
    `)) as unknown as { rows: Record<string, string>[] }
  ).rows;
  const runs = await db
    .select()
    .from(catalogRefreshRunsTable)
    .orderBy(desc(catalogRefreshRunsTable.startedAt))
    .limit(12);
  return {
    refreshActive: isRefreshActive(),
    activeProducts: Number(counts?.active_products ?? 0),
    discontinuedProducts: Number(counts?.discontinued_products ?? 0),
    colors: Number(counts?.colors ?? 0),
    colorsTagged: Number(counts?.colors_tagged ?? 0),
    productsTagged: Number(counts?.products_tagged ?? 0),
    tagOverrides: Number(counts?.tag_overrides ?? 0),
    staffColorFixes: Number(counts?.staff_color_fixes ?? 0),
    recentRuns: runs.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      status: r.status,
      trigger: r.trigger,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      productsUpserted: r.productsUpserted,
      colorsUpserted: r.colorsUpserted,
      discontinuedCount: r.discontinuedCount,
      colorsTagged: r.colorsTagged,
      productsTagged: r.productsTagged,
      error: r.error,
    })),
  };
}
