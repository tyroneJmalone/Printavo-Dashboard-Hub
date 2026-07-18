import { Router, type IRouter } from "express";
import { and, eq, gte, isNotNull, lt } from "drizzle-orm";
import { db, tasksTable } from "@workspace/momintum-db";
import { GetDashboardSummaryQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const query = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  const activeConditions = [eq(tasksTable.completed, false)];
  if (query.data.assigneeId !== undefined) {
    activeConditions.push(eq(tasksTable.assigneeId, query.data.assigneeId));
  }

  const activeTasks = await db
    .select()
    .from(tasksTable)
    .where(and(...activeConditions));

  let overdueCount = 0;
  let todayCount = 0;
  let upcomingCount = 0;

  for (const task of activeTasks) {
    if (!task.dueDate) {
      continue;
    }
    const due = new Date(task.dueDate);
    if (due < startOfToday) {
      overdueCount += 1;
    } else if (due < startOfTomorrow) {
      todayCount += 1;
    } else {
      upcomingCount += 1;
    }
  }

  const completedConditions = [
    eq(tasksTable.completed, true),
    isNotNull(tasksTable.completedAt),
    gte(tasksTable.completedAt, startOfToday),
    lt(tasksTable.completedAt, startOfTomorrow),
  ];
  if (query.data.assigneeId !== undefined) {
    completedConditions.push(eq(tasksTable.assigneeId, query.data.assigneeId));
  }

  const completedTodayRows = await db
    .select()
    .from(tasksTable)
    .where(and(...completedConditions));

  res.json({
    overdueCount,
    todayCount,
    upcomingCount,
    completedTodayCount: completedTodayRows.length,
    totalActiveCount: activeTasks.length,
  });
});

export default router;
