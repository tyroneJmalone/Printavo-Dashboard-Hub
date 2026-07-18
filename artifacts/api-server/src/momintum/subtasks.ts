import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, subtasksTable } from "@workspace/momintum-db";
import {
  ListSubtasksParams,
  CreateSubtaskParams,
  CreateSubtaskBody,
  UpdateSubtaskParams,
  UpdateSubtaskBody,
  DeleteSubtaskParams,
} from "@workspace/api-zod";
import { requireAuth } from "./auth";

const router: IRouter = Router();

router.get("/tasks/:id/subtasks", async (req, res): Promise<void> => {
  const params = ListSubtasksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const subtasks = await db
    .select()
    .from(subtasksTable)
    .where(eq(subtasksTable.taskId, params.data.id))
    .orderBy(subtasksTable.sortOrder, subtasksTable.createdAt);

  res.json(subtasks);
});

router.post(
  "/tasks/:id/subtasks",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateSubtaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = CreateSubtaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [{ maxSortOrder }] = await db
      .select({
        maxSortOrder: sql<number>`coalesce(max(${subtasksTable.sortOrder}), 0)`,
      })
      .from(subtasksTable)
      .where(eq(subtasksTable.taskId, params.data.id));

    const [subtask] = await db
      .insert(subtasksTable)
      .values({
        ...parsed.data,
        taskId: params.data.id,
        sortOrder: Number(maxSortOrder) + 1000,
      })
      .returning();

    res.status(201).json(subtask);
  },
);

router.patch("/subtasks/:id", async (req, res): Promise<void> => {
  const params = UpdateSubtaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateSubtaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [subtask] = await db
    .update(subtasksTable)
    .set(parsed.data)
    .where(eq(subtasksTable.id, params.data.id))
    .returning();

  if (!subtask) {
    res.status(404).json({ error: "Subtask not found" });
    return;
  }

  res.json(subtask);
});

router.delete("/subtasks/:id", async (req, res): Promise<void> => {
  const params = DeleteSubtaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [subtask] = await db
    .delete(subtasksTable)
    .where(eq(subtasksTable.id, params.data.id))
    .returning();

  if (!subtask) {
    res.status(404).json({ error: "Subtask not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
