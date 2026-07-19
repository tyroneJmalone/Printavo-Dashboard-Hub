import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, listGroupsTable } from "@workspace/momintum-db";
import {
  CreateListGroupBody,
  UpdateListGroupParams,
  UpdateListGroupBody,
  DeleteListGroupParams,
} from "@workspace/api-zod";

/**
 * List groups — sidebar folders that lists nest under. Hub-owned tables in
 * the shared live moMINTum DB (see lib/momintum-db/src/schema/listGroups.ts).
 */
const router: IRouter = Router();

router.get("/list-groups", async (_req, res): Promise<void> => {
  const groups = await db
    .select()
    .from(listGroupsTable)
    .orderBy(asc(listGroupsTable.sortOrder), asc(listGroupsTable.id));
  res.json(groups);
});

router.post("/list-groups", async (req, res): Promise<void> => {
  const parsed = CreateListGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [group] = await db
    .insert(listGroupsTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(group);
});

router.patch("/list-groups/:id", async (req, res): Promise<void> => {
  const params = UpdateListGroupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateListGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  const [group] = await db
    .update(listGroupsTable)
    .set(parsed.data)
    .where(eq(listGroupsTable.id, params.data.id))
    .returning();
  if (!group) {
    res.status(404).json({ error: "List group not found" });
    return;
  }
  res.json(group);
});

router.delete("/list-groups/:id", async (req, res): Promise<void> => {
  const params = DeleteListGroupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Memberships cascade — nested lists simply become ungrouped.
  const [group] = await db
    .delete(listGroupsTable)
    .where(eq(listGroupsTable.id, params.data.id))
    .returning();
  if (!group) {
    res.status(404).json({ error: "List group not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
