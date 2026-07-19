import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  listsTable,
  listGroupsTable,
  listGroupMembershipsTable,
  type List,
} from "@workspace/momintum-db";
import {
  CreateListBody,
  UpdateListParams,
  UpdateListBody,
  DeleteListParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

/** The API's List DTO carries groupId (hub-owned membership table) even
 *  though the live `lists` table has no such column. */
async function withGroupIds(lists: List[]): Promise<(List & { groupId: number | null })[]> {
  const memberships = await db.select().from(listGroupMembershipsTable);
  const byListId = new Map(memberships.map((m) => [m.listId, m.groupId]));
  return lists.map((l) => ({ ...l, groupId: byListId.get(l.id) ?? null }));
}

async function setListGroup(
  listId: number,
  groupId: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (groupId === null) {
    await db
      .delete(listGroupMembershipsTable)
      .where(eq(listGroupMembershipsTable.listId, listId));
    return { ok: true };
  }
  const [group] = await db
    .select()
    .from(listGroupsTable)
    .where(eq(listGroupsTable.id, groupId))
    .limit(1);
  if (!group) return { ok: false, error: "List group not found" };
  await db
    .insert(listGroupMembershipsTable)
    .values({ listId, groupId })
    .onConflictDoUpdate({
      target: listGroupMembershipsTable.listId,
      set: { groupId },
    });
  return { ok: true };
}

router.get("/lists", async (_req, res): Promise<void> => {
  const lists = await db
    .select()
    .from(listsTable)
    .orderBy(listsTable.createdAt);
  res.json(await withGroupIds(lists));
});

router.post("/lists", async (req, res): Promise<void> => {
  const parsed = CreateListBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { groupId, ...listData } = parsed.data;

  if (groupId != null) {
    const [group] = await db
      .select()
      .from(listGroupsTable)
      .where(eq(listGroupsTable.id, groupId))
      .limit(1);
    if (!group) {
      res.status(400).json({ error: "List group not found" });
      return;
    }
  }

  const [list] = await db.insert(listsTable).values(listData).returning();
  if (!list) {
    res.status(500).json({ error: "Failed to create list" });
    return;
  }

  let effectiveGroupId: number | null = null;
  if (groupId != null) {
    const result = await setListGroup(list.id, groupId);
    if (result.ok) effectiveGroupId = groupId;
  }

  res.status(201).json({ ...list, groupId: effectiveGroupId });
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

  const { groupId, ...listData } = parsed.data;

  let list: List | undefined;
  if (Object.keys(listData).length > 0) {
    [list] = await db
      .update(listsTable)
      .set(listData)
      .where(eq(listsTable.id, params.data.id))
      .returning();
  } else {
    [list] = await db
      .select()
      .from(listsTable)
      .where(eq(listsTable.id, params.data.id))
      .limit(1);
  }

  if (!list) {
    res.status(404).json({ error: "List not found" });
    return;
  }

  if (groupId !== undefined) {
    const result = await setListGroup(list.id, groupId ?? null);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
  }

  const [withGroup] = await withGroupIds([list]);
  res.json(withGroup);
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
