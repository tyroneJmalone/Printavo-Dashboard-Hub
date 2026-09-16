import {
  AlertTriangle,
  Check,
  ChevronDown,
  History,
  Loader2,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import type {
  KnowledgePlaygroundFeedback,
  KnowledgePlaygroundFeedbackInput,
  KnowledgePlaygroundFeedbackIssue,
  KnowledgePlaygroundFeedbackVerdict,
  KnowledgePlaygroundResponse,
} from "@workspace/api-client-react";

export const FEEDBACK_ISSUES: Array<{
  value: KnowledgePlaygroundFeedbackIssue;
  label: string;
}> = [
  { value: "facts", label: "Facts or citation" },
  { value: "missing_knowledge", label: "Missing knowledge" },
  { value: "tone", label: "Tone" },
  { value: "wording", label: "Wording" },
];

/**
 * Build the exact payload at click time. Keeping this pure makes it clear
 * that a pending save owns the message/result pair that was visible when the
 * staff member clicked Save; later edits do not mutate this object.
 */
export function buildKnowledgePlaygroundFeedbackInput(
  message: string,
  result: KnowledgePlaygroundResponse,
  verdict: KnowledgePlaygroundFeedbackVerdict,
  issues: KnowledgePlaygroundFeedbackIssue[],
  comment: string,
  correctedReply: string,
): KnowledgePlaygroundFeedbackInput {
  const snapshot = {
    trust: "staff-submitted" as const,
    reply: result.reply,
    searchQueries: result.searchQueries,
    retrievedEntries: result.retrievedEntries,
    usedEntryIds: result.usedEntryIds,
    brandGuidance: result.brandGuidance,
    includeDrafts: result.includeDrafts,
    note: result.note,
  } as KnowledgePlaygroundFeedbackInput["snapshot"];

  return {
    message: message.trim(),
    verdict,
    issues: [...issues],
    comment: comment.trim() || null,
    correctedReply: correctedReply.trim() || null,
    snapshot,
    includeDrafts: result.includeDrafts,
    sources: result.retrievedEntries,
  };
}

function formatFeedbackDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function FeedbackHistoryCard({
  feedback,
  onReviewChange,
  reviewPending,
}: {
  feedback: KnowledgePlaygroundFeedback;
  onReviewChange: (feedback: KnowledgePlaygroundFeedback) => void;
  reviewPending: boolean;
}) {
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-950/25 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              feedback.verdict === "helpful"
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-amber-500/15 text-amber-200"
            }`}
          >
            {feedback.verdict === "helpful" ? <ThumbsUp size={11} /> : <ThumbsDown size={11} />}
            {feedback.verdict === "helpful" ? "Helpful" : "Needs work"}
          </span>
          {feedback.includeDrafts && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-200">
              Draft-inclusive test
            </span>
          )}
          {feedback.issues.map((issue) => (
            <span key={issue} className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">
              {FEEDBACK_ISSUES.find((option) => option.value === issue)?.label ?? issue}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onReviewChange(feedback)}
          disabled={reviewPending}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
            feedback.reviewed
              ? "border-emerald-800/70 text-emerald-300 hover:bg-emerald-950/30"
              : "border-slate-700 text-slate-300 hover:bg-slate-800"
          }`}
        >
          {reviewPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {feedback.reviewed ? "Reviewed — reopen" : "Mark reviewed"}
        </button>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Message tested
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{feedback.message}</p>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Suggested reply snapshot
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
            {feedback.snapshot.reply}
          </p>
        </div>
      </div>

      {feedback.correctedReply && (
        <div className="mt-3 rounded-md border border-emerald-900/50 bg-emerald-950/15 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">
            Staff correction
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
            {feedback.correctedReply}
          </p>
        </div>
      )}
      {feedback.comment && (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Comment</div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{feedback.comment}</p>
        </div>
      )}

      <details className="group mt-3 rounded-md border border-slate-800 bg-slate-950/20">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 marker:hidden [&::-webkit-details-marker]:hidden">
          <ChevronDown size={13} className="text-slate-500 transition-transform group-open:rotate-180" />
          Sources ({feedback.sources.length})
          <span className="ml-auto text-[10px] text-slate-500">
            {feedback.snapshot.trust === "staff-submitted" ? "Staff-submitted snapshot" : "Snapshot"}
          </span>
        </summary>
        <div className="space-y-2 border-t border-slate-800 px-3 py-2.5">
          {feedback.sources.length === 0 ? (
            <p className="text-xs text-slate-500">No matched sources were returned.</p>
          ) : (
            feedback.sources.map((source) => (
              <div key={source.id} className="rounded-md border border-slate-800 bg-slate-900/50 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-300">
                  <span className="font-medium">{source.title}</span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">
                    {source.category}
                  </span>
                  <span className="text-[10px] text-slate-500">{source.reviewStatus}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{source.body}</p>
              </div>
            ))
          )}
        </div>
      </details>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span>Submitted by {feedback.submittedBy.email}</span>
        <span>{formatFeedbackDate(feedback.createdAt)}</span>
        {feedback.reviewedBy && <span>Reviewed by {feedback.reviewedBy.email}</span>}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        This is immutable staff feedback evidence. It does not modify or approve knowledge-base entries.
      </p>
    </article>
  );
}

export function FeedbackForm({
  result,
  submittedMessage,
  verdict,
  issues,
  comment,
  correctedReply,
  pending,
  saved,
  error,
  onVerdict,
  onToggleIssue,
  onComment,
  onCorrection,
  onSave,
}: {
  result: KnowledgePlaygroundResponse;
  submittedMessage: string;
  verdict: KnowledgePlaygroundFeedbackVerdict | null;
  issues: KnowledgePlaygroundFeedbackIssue[];
  comment: string;
  correctedReply: string;
  pending: boolean;
  saved: boolean;
  error: string | null;
  onVerdict: (verdict: KnowledgePlaygroundFeedbackVerdict) => void;
  onToggleIssue: (issue: KnowledgePlaygroundFeedbackIssue) => void;
  onComment: (comment: string) => void;
  onCorrection: (correction: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="border-t border-slate-800 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Record feedback</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Nothing is saved from a test automatically. Save only when you explicitly submit this verdict; the tested
            message, reply, sources, and mode are kept as an immutable staff-submitted snapshot.
          </p>
        </div>
        {saved && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300">
            <Check size={12} /> Feedback saved
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onVerdict("helpful")}
          className={`inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium ${
            verdict === "helpful"
              ? "border-emerald-600/70 bg-emerald-500/15 text-emerald-200"
              : "border-slate-700 text-slate-300 hover:bg-slate-800"
          }`}
        >
          <ThumbsUp size={14} /> Helpful
        </button>
        <button
          type="button"
          onClick={() => onVerdict("needs_work")}
          className={`inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium ${
            verdict === "needs_work"
              ? "border-amber-600/70 bg-amber-500/15 text-amber-200"
              : "border-slate-700 text-slate-300 hover:bg-slate-800"
          }`}
        >
          <ThumbsDown size={14} /> Needs work
        </button>
      </div>

      {verdict && (
        <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-950/25 p-3">
          <fieldset>
            <legend className="text-xs font-medium text-slate-300">What should be improved? (optional)</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {FEEDBACK_ISSUES.map((issue) => (
                <label key={issue.value} className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={issues.includes(issue.value)}
                    onChange={() => onToggleIssue(issue.value)}
                    className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 accent-emerald-500"
                  />
                  {issue.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="knowledge-playground-correction" className="text-xs font-medium text-slate-300">
              Corrected reply (optional)
            </label>
            <textarea
              id="knowledge-playground-correction"
              value={correctedReply}
              onChange={(event) => onCorrection(event.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="Write a better reply for a human reviewer. This does not update the knowledge base."
              className="mt-1.5 w-full resize-y rounded-md border border-slate-700 bg-[#1e293b] px-3 py-2 text-sm leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-[#059669] focus:outline-none focus:ring-1 focus:ring-[#059669]"
            />
            <div className="mt-1 text-right text-[10px] text-slate-500">
              {correctedReply.length.toLocaleString()} / 4,000
            </div>
          </div>

          <div>
            <label htmlFor="knowledge-playground-feedback-comment" className="text-xs font-medium text-slate-300">
              Comment (optional)
            </label>
            <textarea
              id="knowledge-playground-feedback-comment"
              value={comment}
              onChange={(event) => onComment(event.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Add context for the reviewer."
              className="mt-1.5 w-full resize-y rounded-md border border-slate-700 bg-[#1e293b] px-3 py-2 text-sm leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-[#059669] focus:outline-none focus:ring-1 focus:ring-[#059669]"
            />
            <div className="mt-1 text-right text-[10px] text-slate-500">
              {comment.length.toLocaleString()} / 2,000
            </div>
          </div>

          {error && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">
              <AlertTriangle size={14} aria-hidden="true" />
              <span className="flex-1">{error}</span>
              <button
                type="button"
                onClick={onSave}
                disabled={pending}
                className="inline-flex items-center gap-1 rounded-md border border-red-800/70 px-2 py-1 text-[11px] font-medium hover:bg-red-900/40 disabled:opacity-50"
              >
                <RotateCcw size={12} /> Retry save
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={pending || saved || comment.length > 2000 || correctedReply.length > 4000}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#059669] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#047857] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {saved ? "Saved" : "Save feedback"}
          </button>
          <p className="text-[10px] leading-relaxed text-slate-600">
            Saved feedback is for human review only. It never approves, promotes, or changes knowledge entries.
          </p>
        </div>
      )}
    </div>
  );
}

export function FeedbackHistoryPanel({
  history,
  pending,
  error,
  reviewPendingId,
  onRefresh,
  onReview,
}: {
  history: KnowledgePlaygroundFeedback[];
  pending: boolean;
  error: string | null;
  reviewPendingId: string | null;
  onRefresh: () => void;
  onReview: (feedback: KnowledgePlaygroundFeedback) => void;
}) {
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Recent feedback</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Review saved test snapshots after reload. Marking feedback reviewed changes only its review status.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
          Refresh
        </button>
      </div>
      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onRefresh} className="rounded-md border border-red-800/70 px-2 py-1 hover:bg-red-900/40">
            Retry
          </button>
        </div>
      )}
      {pending && history.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/30 px-3.5 py-3 text-sm text-slate-400" role="status">
          <Loader2 size={16} className="animate-spin text-[#10b981]" /> Loading saved feedback…
        </div>
      ) : history.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-950/25 px-3.5 py-4 text-sm text-slate-400">
          No saved feedback yet. Run a test and explicitly save a verdict to see it here.
        </div>
      ) : (
        history.map((feedback) => (
          <FeedbackHistoryCard
            key={feedback.id}
            feedback={feedback}
            onReviewChange={onReview}
            reviewPending={reviewPendingId === feedback.id}
          />
        ))
      )}
    </div>
  );
}

export function FeedbackHistoryTabButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs font-medium ${
        active
          ? "border-[#10b981] text-emerald-300"
          : "border-transparent text-slate-500 hover:text-slate-300"
      }`}
    >
      <History size={13} aria-hidden="true" />
      Feedback history
    </button>
  );
}