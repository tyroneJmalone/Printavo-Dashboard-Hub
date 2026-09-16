import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  knowledgePlaygroundFeedbackTable,
  type KnowledgePlaygroundFeedback,
} from "@workspace/db";
import {
  CreateKnowledgePlaygroundFeedbackResponse,
  ListKnowledgePlaygroundFeedbackQueryParams,
  ListKnowledgePlaygroundFeedbackResponse,
  UpdateKnowledgePlaygroundFeedbackReviewBody,
  UpdateKnowledgePlaygroundFeedbackReviewParams,
  UpdateKnowledgePlaygroundFeedbackReviewResponse,
} from "@workspace/api-zod";
import {
  buildKnowledgePlaygroundFeedbackInsertValues,
  buildKnowledgePlaygroundFeedbackReviewPatch,
  normalizeKnowledgePlaygroundFeedback,
} from "../lib/knowledgePlaygroundFeedback";

const router: IRouter = Router();
const DEFAULT_FEEDBACK_LIMIT = 50;

function feedbackDto(row: KnowledgePlaygroundFeedback) {
  return {
    id: row.id,
    message: row.message,
    verdict: row.verdict,
    issues: row.issues,
    comment: row.comment,
    correctedReply: row.correctedReply,
    snapshot: row.resultSnapshot,
    includeDrafts: row.includeDrafts,
    sources: row.sources,
    submittedBy: {
      staffId: row.submittedByStaffId,
      email: row.submittedByEmail,
    },
    reviewed: row.reviewed,
    reviewedBy: row.reviewedByStaffId && row.reviewedByEmail
      ? {
          staffId: row.reviewedByStaffId,
          email: row.reviewedByEmail,
        }
      : null,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get("/knowledge/playground-feedback", async (req, res): Promise<void> => {
  const parsed = ListKnowledgePlaygroundFeedbackQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const limit = parsed.data.limit ?? DEFAULT_FEEDBACK_LIMIT;
  const rows = await db
    .select()
    .from(knowledgePlaygroundFeedbackTable)
    .orderBy(desc(knowledgePlaygroundFeedbackTable.createdAt))
    .limit(limit);

  res.json(
    ListKnowledgePlaygroundFeedbackResponse.parse({
      feedback: rows.map(feedbackDto),
    }),
  );
});

router.post("/knowledge/playground-feedback", async (req, res): Promise<void> => {
  const parsed = normalizeKnowledgePlaygroundFeedback(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const values = buildKnowledgePlaygroundFeedbackInsertValues(parsed.data, req.staff!);

  const [row] = await db
    .insert(knowledgePlaygroundFeedbackTable)
    .values(values)
    .returning();

  if (!row) {
    res.status(503).json({ error: "Feedback could not be saved. Try again." });
    return;
  }

  req.log.info(
    { feedbackId: row.id, verdict: row.verdict, by: req.staff!.email },
    "knowledge playground feedback saved",
  );
  res.status(201).json(CreateKnowledgePlaygroundFeedbackResponse.parse(feedbackDto(row)));
});

router.patch(
  "/knowledge/playground-feedback/:id/review",
  async (req, res): Promise<void> => {
    const params = UpdateKnowledgePlaygroundFeedbackReviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateKnowledgePlaygroundFeedbackReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const reviewed = parsed.data.reviewed;
    const reviewPatch = buildKnowledgePlaygroundFeedbackReviewPatch(
      reviewed,
      req.staff!,
      new Date(),
    );
    const [row] = await db
      .update(knowledgePlaygroundFeedbackTable)
      .set({
        ...reviewPatch,
        updatedAt: new Date(),
      })
      .where(eq(knowledgePlaygroundFeedbackTable.id, params.data.id))
      .returning();

    if (!row) {
      res.status(404).json({ error: "Knowledge playground feedback not found." });
      return;
    }

    req.log.info(
      { feedbackId: row.id, reviewed, by: req.staff!.email },
      reviewed ? "knowledge playground feedback reviewed" : "knowledge playground feedback reopened",
    );
    res.json(UpdateKnowledgePlaygroundFeedbackReviewResponse.parse(feedbackDto(row)));
  },
);

export default router;