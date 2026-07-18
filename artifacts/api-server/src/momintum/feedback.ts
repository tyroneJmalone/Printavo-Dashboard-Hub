import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, membersTable, feedbackTable } from "@workspace/momintum-db";
import { requireAuth, requireAdmin, getOrCreateCurrentMember } from "./auth";

const router: IRouter = Router();

// NOTE: the standalone app emails admins on new feedback (Resend connector
// lives there). The hub stores the row only — admins still see it in both
// apps' feedback inboxes since the database is shared.

router.post("/feedback", requireAuth, async (req, res): Promise<void> => {
  const member = await getOrCreateCurrentMember(req);
  const { type, title, body } = req.body as {
    type?: string;
    title?: string;
    body?: string;
  };

  if (!title?.trim() || !body?.trim()) {
    res.status(400).json({ error: "title and body are required" });
    return;
  }

  const validTypes = ["bug", "feature", "idea", "general"];
  const feedbackType = validTypes.includes(type ?? "")
    ? (type as string)
    : "general";

  const [created] = await db
    .insert(feedbackTable)
    .values({
      memberId: member?.id ?? null,
      type: feedbackType,
      title: title.trim(),
      body: body.trim(),
      status: "open",
    })
    .returning();

  res.status(201).json(created);
});

router.get("/feedback", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: feedbackTable.id,
      memberId: feedbackTable.memberId,
      type: feedbackTable.type,
      title: feedbackTable.title,
      body: feedbackTable.body,
      status: feedbackTable.status,
      createdAt: feedbackTable.createdAt,
      updatedAt: feedbackTable.updatedAt,
      memberName: membersTable.name,
      memberEmail: membersTable.email,
      memberColor: membersTable.color,
    })
    .from(feedbackTable)
    .leftJoin(membersTable, eq(feedbackTable.memberId, membersTable.id))
    .orderBy(desc(feedbackTable.createdAt));

  res.json(rows);
});

router.patch("/feedback/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { status } = req.body as { status?: string };
  const validStatuses = ["open", "acknowledged", "done"];
  if (!status || !validStatuses.includes(status)) {
    res
      .status(400)
      .json({ error: "status must be one of: open, acknowledged, done" });
    return;
  }

  const [updated] = await db
    .update(feedbackTable)
    .set({ status })
    .where(eq(feedbackTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(updated);
});

router.delete("/feedback/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(feedbackTable).where(eq(feedbackTable.id, id));
  res.status(204).send();
});

export default router;
