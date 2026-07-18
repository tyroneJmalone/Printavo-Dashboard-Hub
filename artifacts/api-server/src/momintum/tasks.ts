import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, tasksTable, listsTable } from "@workspace/momintum-db";
import {
  CreateTaskBody,
  ListTasksQueryParams,
  GetTaskParams,
  UpdateTaskParams,
  UpdateTaskBody,
  DeleteTaskParams,
  BulkUpdateTasksBody,
  BulkDeleteTasksBody,
  DuplicateTaskParams,
} from "@workspace/api-zod";
import { requireAuth, getOrCreateCurrentMember } from "./auth";

async function checkPrivateListAccess(
  listId: number | null | undefined,
  currentMemberId: number | undefined,
): Promise<{ forbidden: boolean }> {
  if (!listId) return { forbidden: false };
  const [list] = await db.select().from(listsTable).where(eq(listsTable.id, listId));
  if (!list || !list.ownerId) return { forbidden: false };
  return { forbidden: list.ownerId !== currentMemberId };
}

const router: IRouter = Router();

function coerceBooleanQueryParam(
  rawQuery: Record<string, unknown>,
  key: string,
): void {
  if (rawQuery[key] === "false" || rawQuery[key] === "true") {
    rawQuery[key] = rawQuery[key] === "true";
  }
}

router.get("/tasks", async (req, res): Promise<void> => {
  const rawQuery: Record<string, unknown> = { ...req.query };
  coerceBooleanQueryParam(rawQuery, "completed");
  coerceBooleanQueryParam(rawQuery, "deleted");

  const query = ListTasksQueryParams.safeParse(rawQuery);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const currentMember = await getOrCreateCurrentMember(req);

  const conditions = [];

  // Visibility: non-admins only see tasks they created/are assigned to,
  // or tasks that belong to a shared list (ownerId = null).
  if (currentMember && !currentMember.isAdmin) {
    const sharedLists = await db
      .select({ id: listsTable.id })
      .from(listsTable)
      .where(isNull(listsTable.ownerId));
    const sharedListIds = sharedLists.map((l) => l.id);

    conditions.push(
      or(
        sharedListIds.length > 0
          ? inArray(tasksTable.listId, sharedListIds)
          : sql`false`,
        eq(tasksTable.createdById, currentMember.id),
        eq(tasksTable.assigneeId, currentMember.id),
      ),
    );
  }

  if (query.data.listId !== undefined) {
    conditions.push(eq(tasksTable.listId, query.data.listId));
  }
  if (query.data.deleted === true) {
    conditions.push(isNotNull(tasksTable.deletedAt));
  } else {
    conditions.push(isNull(tasksTable.deletedAt));
  }
  if (query.data.completed !== undefined) {
    conditions.push(eq(tasksTable.completed, query.data.completed));
  }
  if (query.data.assigneeId !== undefined) {
    conditions.push(eq(tasksTable.assigneeId, query.data.assigneeId));
  }
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    conditions.push(
      or(ilike(tasksTable.title, term), ilike(tasksTable.notes, term)),
    );
  }

  const orderBy = (() => {
    switch (query.data.sortBy) {
      case "dueDate":
        return [
          sql`${tasksTable.dueDate} IS NULL`,
          asc(tasksTable.dueDate),
          asc(tasksTable.sortOrder),
        ];
      case "priority":
        return [
          sql`CASE ${tasksTable.priority} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`,
          asc(tasksTable.sortOrder),
        ];
      case "title":
        return [asc(tasksTable.title)];
      case "createdAt":
        return [desc(tasksTable.createdAt)];
      case "manual":
      default:
        return [asc(tasksTable.sortOrder), asc(tasksTable.createdAt)];
    }
  })();

  const tasks = await db
    .select()
    .from(tasksTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy);

  res.json(tasks);
});

router.post("/tasks", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const currentMember = await getOrCreateCurrentMember(req);

  if (parsed.data.listId) {
    const { forbidden } = await checkPrivateListAccess(parsed.data.listId, currentMember?.id);
    if (forbidden) {
      res.status(403).json({ error: "You cannot add tasks to this private list." });
      return;
    }
  }

  const [{ maxSortOrder }] = await db
    .select({ maxSortOrder: sql<number>`coalesce(max(${tasksTable.sortOrder}), 0)` })
    .from(tasksTable);

  const [task] = await db
    .insert(tasksTable)
    .values({
      ...parsed.data,
      createdById: currentMember?.id ?? null,
      sortOrder: Number(maxSortOrder) + 1000,
    })
    .returning();

  res.status(201).json(task);
});

router.post("/tasks/bulk-update", async (req, res): Promise<void> => {
  const parsed = BulkUpdateTasksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ids, data } = parsed.data;
  if (Object.keys(data).length === 0) {
    res.json([]);
    return;
  }

  const updateValues: typeof data & { completedAt?: Date | null } = { ...data };
  if (data.completed === true) {
    updateValues.completedAt = new Date();
  } else if (data.completed === false) {
    updateValues.completedAt = null;
  }

  const updated = await db
    .update(tasksTable)
    .set(updateValues)
    .where(inArray(tasksTable.id, ids))
    .returning();

  res.json(updated);
});

router.post("/tasks/bulk-delete", async (req, res): Promise<void> => {
  const parsed = BulkDeleteTasksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await db
    .update(tasksTable)
    .set({ deletedAt: new Date() })
    .where(inArray(tasksTable.id, parsed.data.ids));

  res.sendStatus(204);
});

router.get("/tasks/:id", async (req, res): Promise<void> => {
  const params = GetTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, params.data.id));

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json(task);
});

function getNextDueDate(
  recurrence: string,
  fromDate: Date,
): Date {
  const next = new Date(fromDate);
  switch (recurrence) {
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
    case "yearly":
      next.setFullYear(next.getFullYear() + 1);
      break;
  }
  return next;
}

router.post("/tasks/:id/duplicate", requireAuth, async (req, res): Promise<void> => {
  const params = DuplicateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [source] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
  if (!source) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const currentMember = await getOrCreateCurrentMember(req);

  if (source.listId) {
    const { forbidden } = await checkPrivateListAccess(source.listId, currentMember?.id);
    if (forbidden) {
      res.status(403).json({ error: "You cannot add tasks to this private list." });
      return;
    }
  }

  const [{ maxSortOrder }] = await db
    .select({ maxSortOrder: sql<number>`coalesce(max(${tasksTable.sortOrder}), 0)` })
    .from(tasksTable);

  const [copy] = await db
    .insert(tasksTable)
    .values({
      title: `${source.title} (copy)`,
      notes: source.notes,
      listId: source.listId,
      assigneeId: source.assigneeId,
      createdById: currentMember?.id ?? null,
      priority: source.priority,
      dueDate: source.dueDate,
      tags: source.tags,
      recurrence: source.recurrence,
      sortOrder: Number(maxSortOrder) + 1000,
    })
    .returning();

  res.status(201).json(copy);
});

router.patch("/tasks/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const currentMember = await getOrCreateCurrentMember(req);

  const [existingTask] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
  if (existingTask?.listId) {
    const { forbidden } = await checkPrivateListAccess(existingTask.listId, currentMember?.id);
    if (forbidden) {
      res.status(403).json({ error: "You cannot modify tasks in this private list." });
      return;
    }
  }
  if (parsed.data.listId && parsed.data.listId !== existingTask?.listId) {
    const { forbidden } = await checkPrivateListAccess(parsed.data.listId, currentMember?.id);
    if (forbidden) {
      res.status(403).json({ error: "You cannot move tasks into this private list." });
      return;
    }
  }

  const updateValues: typeof parsed.data & { completedAt?: Date | null } = {
    ...parsed.data,
  };
  if (parsed.data.completed === true) {
    updateValues.completedAt = new Date();
  } else if (parsed.data.completed === false) {
    updateValues.completedAt = null;
  }

  const [task] = await db
    .update(tasksTable)
    .set(updateValues)
    .where(eq(tasksTable.id, params.data.id))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (
    parsed.data.completed === true &&
    task.recurrence &&
    task.recurrence !== "none"
  ) {
    const baseDate = task.dueDate ? new Date(task.dueDate) : new Date();
    const nextDueDate = getNextDueDate(task.recurrence, baseDate);

    await db.insert(tasksTable).values({
      title: task.title,
      notes: task.notes,
      listId: task.listId,
      assigneeId: task.assigneeId,
      createdById: task.createdById,
      priority: task.priority,
      dueDate: nextDueDate,
      tags: task.tags,
      sortOrder: task.sortOrder,
      recurrence: task.recurrence,
      recurringParentId: task.recurringParentId ?? task.id,
    });
  }

  res.json(task);
});

router.delete("/tasks/:id", async (req, res): Promise<void> => {
  const params = DeleteTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [task] = await db
    .update(tasksTable)
    .set({ deletedAt: new Date() })
    .where(eq(tasksTable.id, params.data.id))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/tasks/:id/restore", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [task] = await db
    .update(tasksTable)
    .set({ deletedAt: null })
    .where(eq(tasksTable.id, params.data.id))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json(task);
});

export default router;
