import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, listsTable } from "@workspace/momintum-db";
import {
  CreateListBody,
  UpdateListParams,
  UpdateListBody,
  DeleteListParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/lists", async (_req, res): Promise<void> => {
  const lists = await db
    .select()
    .from(listsTable)
    .orderBy(listsTable.createdAt);
  res.json(lists);
});

router.post("/lists", async (req, res): Promise<void> => {
  const parsed = CreateListBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [list] = await db.insert(listsTable).values(parsed.data).returning();

  res.status(201).json(list);
});

router.patch("/lists/:id", async (req, res): Promise<void> => {
  const params = UpdateListParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateListBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [list] = await db
    .update(listsTable)
    .set(parsed.data)
    .where(eq(listsTable.id, params.data.id))
    .returning();

  if (!list) {
    res.status(404).json({ error: "List not found" });
    return;
  }

  res.json(list);
});

router.delete("/lists/:id", async (req, res): Promise<void> => {
  const params = DeleteListParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [list] = await db
    .delete(listsTable)
    .where(eq(listsTable.id, params.data.id))
    .returning();

  if (!list) {
    res.status(404).json({ error: "List not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
