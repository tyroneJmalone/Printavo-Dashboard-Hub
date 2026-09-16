import {
  CreateKnowledgePlaygroundFeedbackBody,
  type KnowledgePlaygroundFeedbackIssue,
  type KnowledgePlaygroundFeedbackSource,
  type KnowledgePlaygroundFeedbackVerdict,
} from "@workspace/api-zod";
import { z } from "zod";

type ParsedFeedbackBody = z.infer<typeof CreateKnowledgePlaygroundFeedbackBody>;
type StaffSubmittedSnapshot = ParsedFeedbackBody["snapshot"] & {
  trust: "staff-submitted";
};

export type FeedbackStaffIdentity = {
  id: string;
  email: string;
};

export type NormalizedKnowledgePlaygroundFeedback = Omit<
  ParsedFeedbackBody,
  "message" | "comment" | "correctedReply" | "snapshot"
> & {
  message: string;
  comment: string | null;
  correctedReply: string | null;
  snapshot: StaffSubmittedSnapshot;
};

export type KnowledgePlaygroundFeedbackInsertValues = {
  message: string;
  verdict: KnowledgePlaygroundFeedbackVerdict;
  issues: KnowledgePlaygroundFeedbackIssue[];
  comment: string | null;
  correctedReply: string | null;
  includeDrafts: boolean;
  resultSnapshot: StaffSubmittedSnapshot;
  sources: KnowledgePlaygroundFeedbackSource[];
  submittedByStaffId: string;
  submittedByEmail: string;
};

export type KnowledgePlaygroundFeedbackReviewPatch = {
  reviewed: boolean;
  reviewedByStaffId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: Date | null;
};

type FeedbackParseFailure = {
  success: false;
  error: string;
};

type FeedbackParseSuccess = {
  success: true;
  data: NormalizedKnowledgePlaygroundFeedback;
};

/**
 * This boundary is deliberately independent of Express and the database.
 * It owns all normalization that must happen before persistence, including
 * server-side trust stamping and duplicate issue rejection.
 */
export function normalizeKnowledgePlaygroundFeedback(
  input: unknown,
): FeedbackParseFailure | FeedbackParseSuccess {
  const parsed = CreateKnowledgePlaygroundFeedbackBody.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.message };
  }

  const message = parsed.data.message.trim();
  if (message.length < 3) {
    return {
      success: false,
      error: "Feedback message must contain at least 3 non-whitespace characters.",
    };
  }
  if (new Set(parsed.data.issues).size !== parsed.data.issues.length) {
    return { success: false, error: "Feedback issues must be unique." };
  }

  const snapshot: StaffSubmittedSnapshot = {
    ...parsed.data.snapshot,
    trust: "staff-submitted",
  };
  if (snapshot.includeDrafts !== parsed.data.includeDrafts) {
    return {
      success: false,
      error: "Feedback includeDrafts must match the saved result snapshot.",
    };
  }

  return {
    success: true,
    data: {
      ...parsed.data,
      message,
      comment: parsed.data.comment?.trim() || null,
      correctedReply: parsed.data.correctedReply?.trim() || null,
      snapshot,
    },
  };
}

/**
 * Identity is supplied only by the authenticated request context. The input
 * body has no authority over ownership or attribution fields.
 */
export function buildKnowledgePlaygroundFeedbackInsertValues(
  feedback: NormalizedKnowledgePlaygroundFeedback,
  staff: FeedbackStaffIdentity,
): KnowledgePlaygroundFeedbackInsertValues {
  return {
    message: feedback.message,
    verdict: feedback.verdict,
    issues: feedback.issues,
    comment: feedback.comment,
    correctedReply: feedback.correctedReply,
    includeDrafts: feedback.includeDrafts,
    resultSnapshot: feedback.snapshot,
    sources: feedback.sources,
    submittedByStaffId: staff.id,
    submittedByEmail: staff.email,
  };
}

export function buildKnowledgePlaygroundFeedbackReviewPatch(
  reviewed: boolean,
  staff: FeedbackStaffIdentity,
  reviewedAt: Date,
): KnowledgePlaygroundFeedbackReviewPatch {
  return {
    reviewed,
    reviewedByStaffId: reviewed ? staff.id : null,
    reviewedByEmail: reviewed ? staff.email : null,
    reviewedAt: reviewed ? reviewedAt : null,
  };
}