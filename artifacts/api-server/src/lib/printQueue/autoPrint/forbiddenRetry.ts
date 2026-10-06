/** Counts are persisted in the existing durable job snapshot, never reset by discovery. */
export interface ForbiddenRetryState {
  failures: number;
  delayMs: number | null;
}

export function isWorkorder403(error: unknown, phase: string): boolean {
  return phase === "render" && /Printavo returned 403\b/.test(error instanceof Error ? error.message : String(error));
}

export function nextForbiddenRetry(previous?: ForbiddenRetryState): ForbiddenRetryState {
  const failures = (previous?.failures ?? 0) + 1;
  const delayMs = [1000, 2000, 15 * 60_000, 1000, 2000][failures - 1] ?? null;
  return { failures, delayMs };
}

export function forbiddenRetryMessage(state: ForbiddenRetryState): string {
  if (state.failures === 3) return "Printavo 403: round 1 exhausted; waiting 15 minutes for the final round. Print Error status withheld.";
  if (state.failures >= 6) return "Printavo 403 recovery exhausted both rounds; manual review required.";
  return `Printavo 403 recovery: round ${state.failures <= 3 ? 1 : 2}, attempt ${(state.failures - 1) % 3 + 1} failed; retrying this round.`;
}
