import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, commentsTable } from "@workspace/momintum-db";
import {
  ListCommentsParams,
  CreateCommentParams,
  CreateCommentBody,
  ListMentionsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, getOrCreateCurrentMember } from "./auth";

const router: IRouter = Router();

router.get("/mentions", requireAuth, async (req, res): Promise<void> => {
  const query = ListMentionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const mentions = await db
    .select()
    .from(commentsTable)
    .where(sql`${query.data.memberId} = ANY(${commentsTable.mentionedMemberIds})`)
    .orderBy(commentsTable.createdAt);

  res.json(mentions);
});

router.get("/tasks/:id/comments", async (req, res): Promise<void> => {
  const params = ListCommentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const comments = await db
    .select()
    .from(commentsTable)
    .where(eq(commentsTable.taskId, params.data.id))
    .orderBy(commentsTable.createdAt);

  res.json(comments);
});

router.post(
  "/tasks/:id/comments",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateCommentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = CreateCommentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const currentMember = await getOrCreateCurrentMember(req);

    const [comment] = await db
      .insert(commentsTable)
      .values({
        ...parsed.data,
        taskId: params.data.id,
        authorId: currentMember?.id ?? null,
      })
      .returning();

    res.status(201).json(comment);
  },
);

export default router;
