export interface PoLogSubmissionState {
  id: string;
  submittedToVendorAt: string | null;
  pushedToPrintavoAt?: string | null;
  pushState?: { status: string } | null;
}

/**
 * Both vendor submission and a completed Printavo push are required for history.
 * A failed/running re-push stays actionable even if an older push succeeded.
 */
export function partitionPoLog<T extends PoLogSubmissionState>(poFiles: T[]): {
  pending: T[];
  history: T[];
} {
  const pending: T[] = [];
  const history: T[] = [];
  for (const po of poFiles) {
    const complete =
      po.submittedToVendorAt &&
      po.pushedToPrintavoAt &&
      po.pushState?.status !== "running" &&
      po.pushState?.status !== "failed";
    (complete ? history : pending).push(po);
  }
  return { pending, history };
}