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
    const [counts, seed, incremental, watermarks] = await Promise.all([
      tableCounts(),
      latestRun("seed"),
      latestRun("incremental"),
      listWatermarks(),
    ]);
    res.json({
      configured: printavoConfigured(),
      seedActive: isSeedActive(),
      counts,
      seed: runInfo(seed),
      lastIncremental: runInfo(incremental),
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

router.post("/sync/poll", async (req, res) => {
  try {
    const result = await runIncrementalPoll("manual", req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to run poll");
    res.status(500).json({ error: "Failed to run poll" });
  }
});

export default router;
