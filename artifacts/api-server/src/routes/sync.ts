import { Router, type IRouter } from "express";
import { db, changeEventsTable } from "@workspace/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { printavoConfigured, printavoClientStats } from "../lib/printavoGateway";
import {
  latestRun,
  listWatermarks,
  tableCounts,
} from "../lib/sync/state";
import { startOrResumeSeed, isSeedActive } from "../lib/sync/seed";
import {
  startOrResumeDetailBackfill,
  isDetailBackfillActive,
} from "../lib/sync/detail";
import {
  startOrResumePaymentsSeed,
  isPaymentsSeedActive,
} from "../lib/sync/payments";
import { runIncrementalPoll } from "../lib/sync/incremental";
import { schedulerInfo } from "../lib/sync/scheduler";
import type { SyncRun } from "@workspace/db";

const router: IRouter = Router();

function runInfo(run: SyncRun | null) {
  if (!run) return null;
  return {
    id: run.id,
    runType: run.runType,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    stats: (run.stats as Record<string, unknown> | null) ?? null,
    error: run.error ?? null,
  };
}

router.get("/sync/status", async (req, res) => {
  try {
    const [counts, seed, incremental, detailBackfill, paymentsSeed, watermarks] =
      await Promise.all([
        tableCounts(),
        latestRun("seed"),
        latestRun("incremental"),
        latestRun("detail_backfill"),
        latestRun("payments_seed"),
        listWatermarks(),
      ]);
    res.json({
      configured: printavoConfigured(),
      seedActive: isSeedActive(),
      detailBackfillActive: isDetailBackfillActive(),
      paymentsSeedActive: isPaymentsSeedActive(),
      counts,
      seed: runInfo(seed),
      lastIncremental: runInfo(incremental),
      detailBackfill: runInfo(detailBackfill),
      paymentsSeed: runInfo(paymentsSeed),
      watermarks: watermarks.map((w) => ({
        entity: w.entity,
        watermark: w.watermark.toISOString(),
      })),
      scheduler: schedulerInfo(),
      gateway: printavoClientStats(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build sync status");
    res.status(500).json({ error: "Failed to load sync status" });
  }
});

router.get("/sync/events", async (req, res) => {
  try {
    const rawLimit = Number(req.query["limit"]);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 200)
      : 50;
    const entityType = typeof req.query["entityType"] === "string"
      ? req.query["entityType"]
      : null;
    const eventType = typeof req.query["eventType"] === "string"
      ? req.query["eventType"]
      : null;

    const conditions: SQL[] = [];
    if (entityType) conditions.push(eq(changeEventsTable.entityType, entityType));
    if (eventType) conditions.push(eq(changeEventsTable.eventType, eventType));

    const baseQuery = db.select().from(changeEventsTable);
    const rows = await (conditions.length > 0
      ? baseQuery.where(and(...conditions))
      : baseQuery)
      .orderBy(desc(changeEventsTable.occurredAt), desc(changeEventsTable.id))
      .limit(limit);

    res.json(
      rows.map((r) => ({
        id: r.id,
        entityType: r.entityType,
        entityId: r.entityId,
        visualId: r.visualId ?? null,
        eventType: r.eventType,
        field: r.field ?? null,
        oldValue: r.oldValue ?? null,
        newValue: r.newValue ?? null,
        occurredAt: r.occurredAt.toISOString(),
        syncRunId: r.syncRunId ?? null,
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list change events");
    res.status(500).json({ error: "Failed to list change events" });
  }
});

router.post("/sync/seed", async (req, res) => {
  try {
    const result = await startOrResumeSeed(req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to start seed");
    res.status(500).json({ error: "Failed to start seed" });
  }
});

router.post("/sync/detail-backfill", async (req, res) => {
  try {
    const result = await startOrResumeDetailBackfill(req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to start detail backfill");
    res.status(500).json({ error: "Failed to start detail backfill" });
  }
});

router.post("/sync/payments-seed", async (req, res) => {
  try {
    const result = await startOrResumePaymentsSeed(req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to start payments seed");
    res.status(500).json({ error: "Failed to start payments seed" });
  }
});

router.post("/sync/poll", async (req, res) => {
  try {
    // A real poll holds the Printavo-throttled crawl for ~1-3 minutes, which
    // is longer than the dev/prod proxies keep an idle HTTP response alive
    // (observed cutoff ~48s). So: give the poll a short head start — guard
    // no-ops ("already running", "seed active", creds missing) resolve in
    // milliseconds and are returned directly. If it is still going after the
    // grace period, respond immediately with ran:true / "Poll started" and
    // let it finish in the background; clients watch GET /sync/status for
    // the run to leave "running" state.
    const pollPromise = runIncrementalPoll("manual", req.log);
    const GRACE_MS = 1500;
    const raced = await Promise.race([
      pollPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GRACE_MS)),
    ]);
    if (raced !== null) {
      res.json(raced);
      return;
    }
    // Detached completion: runIncrementalPoll never rejects (it catches and
    // returns ran:false), but guard against surprises so nothing is unhandled.
    pollPromise.catch((err) => {
      req.log.error({ err }, "Background poll promise rejected unexpectedly");
    });
    res.json({
      ran: true,
      message: "Poll started — pulling the latest from Printavo in the background",
      stats: null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to run poll");
    res.status(500).json({ error: "Failed to run poll" });
  }
});

export default router;
