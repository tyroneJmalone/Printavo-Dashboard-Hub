import { Router, type IRouter } from "express";
import listsRouter from "./lists";
import listGroupsRouter from "./listGroups";
import tasksRouter from "./tasks";
import membersRouter from "./members";
import commentsRouter from "./comments";
import subtasksRouter from "./subtasks";
import dashboardRouter from "./dashboard";
import quotesRouter from "./quotes";
import teamsRouter from "./teams";
import feedbackRouter from "./feedback";

/**
 * moMINTum routes, ported from the standalone app and mounted at
 * /api/momintum/* BEHIND requireStaff (see routes/index.ts). They operate on
 * the standalone app's LIVE database via @workspace/momintum-db.
 *
 * Intentionally NOT ported (the standalone app keeps owning these):
 * - /healthz               — hub has its own
 * - TickTick sync + scheduler — running it twice would double-import tasks
 * - Missive webhook + config  — webhook points at the standalone app
 * - POST /members/invite      — Resend connector lives in the standalone app
 * - POST /quotes/seed-if-empty — live DB is already seeded
 */
const router: IRouter = Router();

router.use(listsRouter);
router.use(listGroupsRouter);
router.use(tasksRouter);
router.use(membersRouter);
router.use(commentsRouter);
router.use(subtasksRouter);
router.use(dashboardRouter);
router.use(quotesRouter);
router.use(teamsRouter);
router.use(feedbackRouter);

export default router;
