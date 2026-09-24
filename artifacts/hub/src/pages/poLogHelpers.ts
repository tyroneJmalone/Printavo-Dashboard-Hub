export interface PoLogSubmissionState {
  id: string;
  submittedToVendorAt: string | null;
}

/**
 * A PO only becomes history when submission was positively recorded.
 * Lock/push state is deliberately ignored: previews, unknown responses, and
 * failed submissions must remain actionable in the pending list.
 */
export function partitionPoLog<T extends PoLogSubmissionState>(poFiles: T[]): {
  pending: T[];
  history: T[];
} {
  const pending: T[] = [];
  const history: T[] = [];
  for (const po of poFiles) {
    (po.submittedToVendorAt ? history : pending).push(po);
  }
  return { pending, history };
}