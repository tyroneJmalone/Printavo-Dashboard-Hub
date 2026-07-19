import { eq } from "drizzle-orm";
import { db, tasksTable, type Task } from "@workspace/momintum-db";

/**
 * Shared task-completion semantics — the single source of truth for what
 * "completing a task" means in moMINTum (completedAt stamping + recurring
 * respawn). Used by BOTH the user-facing PATCH /tasks/:id route and the
 * Printavo sync engine, so the sync can never bypass recurrence handling.
 */

export function getNextDueDate(recurrence: string, fromDate: Date): Date {
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

/**
 * Spawn the next occurrence of a recurring task. Field-for-field identical to
 * the standalone app's behavior (title/notes/list/assignee/priority/tags kept;
 * recurringParentId chains to the original). No-op for non-recurring tasks.
 * NOTE: the respawned copy intentionally does NOT inherit `source` — a copy of
 * a Printavo twin is a plain moMINTum task and is never linked back.
 */
export async function respawnIfRecurring(task: Task): Promise<void> {
  if (!task.recurrence || task.recurrence === "none") return;
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

/**
 * Transition-guarded completion setter for the SYNC path. Unlike the PATCH
 * route (which applies whatever the user sent), this only writes when the
 * state actually changes, so a re-run can never double-respawn a recurring
 * task or re-stamp completedAt.
 */
export async function setTaskCompletion(
  taskId: number,
  completed: boolean,
): Promise<Task | null> {
  const [existing] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId));
  if (!existing) return null;
  if (existing.completed === completed) return existing;

  const [task] = await db
    .update(tasksTable)
    .set({ completed, completedAt: completed ? new Date() : null })
    .where(eq(tasksTable.id, taskId))
    .returning();
  if (!task) return null;

  if (completed) await respawnIfRecurring(task);
  return task;
}
