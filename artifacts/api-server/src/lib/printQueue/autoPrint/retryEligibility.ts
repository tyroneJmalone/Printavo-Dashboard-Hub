import type { PqPrintJob } from "@workspace/db";

/** A failed preparatory read is not proof that an already printed order was eligible. */
export function failureStatusEligible(job: Pick<PqPrintJob, "priorJobId" | "contentFingerprint" | "eligibilityCycle" | "snapshotMetadata">) {
  if (!job.priorJobId) return true;
  const fingerprint = (job.snapshotMetadata as { durableRetry?: { fingerprint?: string } } | null)?.durableRetry?.fingerprint;
  return !!fingerprint && fingerprint === job.contentFingerprint && !!job.eligibilityCycle?.startsWith("entry:");
}
