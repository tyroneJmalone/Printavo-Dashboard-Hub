import { Router, type IRouter, type Request, type Response } from "express";
import { db, reorderRequestsTable, type ReorderRequest } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import {
  ListReorderRequestsQueryParams,
  UpdateReorderRequestBody,
} from "@workspace/api-zod";

/**
 * STAFF Reorder Requests inbox — module-gated via the "reorder" module
 * (prefix /reorder-requests). Lists customer-submitted reorder requests
 * and lets staff move them through new → in_progress → done.
 */

const router: IRouter = Router();

function toRecord(row: ReorderRequest) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    orderId: row.orderId,
    visualId: row.visualId ?? null,
    orderNickname: row.orderNickname ?? null,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerCompany: row.customerCompany ?? null,
    notes: row.notes ?? null,
    items: row.items,
    totalQty: row.totalQty,
    status: row.status,
    emailSent: row.emailSent,
  };
}

router.get("/reorder-requests", async (req: Request, res: Response) => {
  const parsed = ListReorderRequestsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const status = parsed.data.status ?? "all";

  try {
    const [rows, countRows] = await Promise.all([
      db
        .select()
        .from(reorderRequestsTable)
        .where(
          status === "all" ? undefined : eq(reorderRequestsTable.status, status),
        )
        .orderBy(desc(reorderRequestsTable.createdAt))
        .limit(1000),
      db
        .select({
          status: reorderRequestsTable.status,
          count: sql<number>`count(*)::int`,
        })
        .from(reorderRequestsTable)
        .groupBy(reorderRequestsTable.status),
    ]);

    const counts = { new: 0, inProgress: 0, done: 0 };
    for (const c of countRows) {
      if (c.status === "new") counts.new = c.count;
      else if (c.status === "in_progress") counts.inProgress = c.count;
      else if (c.status === "done") counts.done = c.count;
    }

    res.json({ requests: rows.map(toRecord), counts });
  } catch (err) {
    req.log.error({ err }, "Failed to list reorder requests");
    res.status(500).json({ error: "Failed to list reorder requests" });
  }
});

router.patch("/reorder-requests/:id", async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const parsed = UpdateReorderRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  try {
    const updated = await db
      .update(reorderRequestsTable)
      .set({ status: parsed.data.status })
      .where(eq(reorderRequestsTable.id, id))
      .returning();
    if (updated.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(toRecord(updated[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to update reorder request");
    res.status(500).json({ error: "Failed to update reorder request" });
  }
});

export default router;
