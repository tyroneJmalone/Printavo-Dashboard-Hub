import { Router } from "express";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db, pqAdminAlertsTable as alerts, pqAdminAlertReadsTable as reads,
  pqPrintJobsTable as jobs, pqPrintRunsTable as runs } from "@workspace/db";
import { ListAutoPrintNotificationsResponse } from "@workspace/api-zod";
import { z } from "zod";
import { requireAdmin } from "../middlewares/requireStaff";
import type { AlertPayload } from "../lib/printQueue/autoPrint/alertEvents";
import { activeAlertPredicate } from "../lib/printQueue/autoPrint/activeAlerts";

export const autoPrintNotificationStore = {
  async list(email: string, offset: number) {
    const [rows, totals, unread] = await Promise.all([
      db.select({ alert: alerts, readAt: reads.readAt, jobStatus: jobs.status,
        nextRetryAt: jobs.nextRetryAt, runStatus: runs.status }).from(alerts)
        .leftJoin(reads, and(eq(reads.alertId, alerts.id), eq(reads.adminEmail, email)))
        .leftJoin(jobs, eq(jobs.id, alerts.jobId)).leftJoin(runs, eq(runs.id, alerts.runId))
        .where(activeAlertPredicate)
        .orderBy(desc(alerts.createdAt), desc(alerts.id)).limit(30).offset(offset),
      db.select({ n: count() }).from(alerts)
        .leftJoin(jobs, eq(jobs.id, alerts.jobId)).leftJoin(runs, eq(runs.id, alerts.runId))
        .where(activeAlertPredicate),
      db.select({ n: count() }).from(alerts)
        .leftJoin(reads, and(eq(reads.alertId, alerts.id), eq(reads.adminEmail, email)))
        .leftJoin(jobs, eq(jobs.id, alerts.jobId)).leftJoin(runs, eq(runs.id, alerts.runId))
        .where(and(activeAlertPredicate, isNull(reads.alertId))),
    ]);
    return {
      total: totals[0]?.n ?? 0, unread: unread[0]?.n ?? 0,
      items: rows.map(row => ({
        ...(row.alert.payload as AlertPayload), id: row.alert.id, kind: row.alert.kind,
        jobId: row.alert.jobId, runId: row.alert.runId, read: !!row.readAt,
        currentState: (row.alert.jobId ? row.jobStatus : row.runStatus) ?? "record_unavailable",
        currentNextAttemptAt: row.nextRetryAt?.toISOString() ?? null,
      })),
    };
  },
  async read(email: string, id: string) {
    const [exists] = await db.select({ id: alerts.id }).from(alerts).where(eq(alerts.id, id));
    if (!exists) return false;
    await db.insert(reads).values({ alertId: id, adminEmail: email }).onConflictDoNothing();
    return true;
  },
};

/** Injectable inbox store permits authorization/delivery tests without any live services. */
export function createAutoPrintNotificationsRouter(store = autoPrintNotificationStore) {
  const router = Router();
  const path = "/print-queue/auto-print/notifications";
  router.get(path, requireAdmin, async (req, res) => {
    const parsed = z.coerce.number().int().min(0).max(1_000_000).safeParse(req.query.offset ?? 0);
    if (!parsed.success) { res.status(400).json({ error: "Invalid offset" }); return; }
    res.set("Cache-Control", "private, no-store");
    res.json(ListAutoPrintNotificationsResponse.parse(await store.list(req.staff!.email, parsed.data)));
  });
  router.post(`${path}/:id/read`, requireAdmin, async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) { res.status(400).json({ error: "Invalid alert ID" }); return; }
    if (!await store.read(req.staff!.email, parsed.data)) { res.status(404).json({ error: "Alert not found" }); return; }
    res.sendStatus(204);
  });
  return router;
}
export default createAutoPrintNotificationsRouter();
