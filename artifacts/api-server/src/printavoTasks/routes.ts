import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db as hubDb, printavoTaskLinksTable } from "@workspace/db";
import { requireAdmin } from "../momintum/auth";
import { getLastRunSummary, isSyncRunning, runSyncCycle } from "./sync";
import { taskSyncPollerInfo } from "./poller";

/**
 * Printavo task-sync control routes. Mounted at /api/printavo-tasks behind
 * requireStaff (see routes/index.ts); both routes below are additionally
 * admin-gated because a sync cycle writes to the LIVE moMINTum database.
 *
 * Interval poller (PT5) lives in ./poller.ts — dormant unless
 * PRINTAVO_TASK_SYNC_ENABLED=true; manual sync-now works either way.
 */
const router: IRouter = Router();

router.get("/status", requireAdmin, async (_req, res): Promise<void> => {
  const [counts] = await hubDb
    .select({
      total: sql<number>`count(*)::int`,
      suppressed: sql<number>`count(*) filter (where ${printavoTaskLinksTable.suppressed})::int`,
      fromPrintavo: sql<number>`count(*) filter (where ${printavoTaskLinksTable.origin} = 'printavo')::int`,
      fromMomintum: sql<number>`count(*) filter (where ${printavoTaskLinksTable.origin} = 'momintum')::int`,
    })
    .from(printavoTaskLinksTable);

  res.json({
    running: isSyncRunning(),
    lastRun: getLastRunSummary(),
    poller: taskSyncPollerInfo(),
    links: counts ?? { total: 0, suppressed: 0, fromPrintavo: 0, fromMomintum: 0 },
  });
});

router.post("/sync-now", requireAdmin, async (req, res): Promise<void> => {
  if (isSyncRunning()) {
    res.status(409).json({ error: "A sync cycle is already running" });
    return;
  }
  const dryRun = req.query["dryRun"] === "true";
  const summary = await runSyncCycle("manual", { dryRun });
  res.json(summary);
});

export default router;
