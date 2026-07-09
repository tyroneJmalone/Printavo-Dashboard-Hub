/**
 * In-memory registry of PO pushes currently running in this process.
 * Split into its own module so both poFiles (DTO reconciliation) and
 * poPush (the runner) can import it without a circular dependency.
 *
 * If the server restarts mid-push the DB row keeps status "running" but the
 * id is gone from this set — readers must surface that as an interrupted
 * (failed) push that can be retried.
 */
const activePushes = new Set<string>();

export function isPushActive(poFileId: string): boolean {
  return activePushes.has(poFileId);
}

/** Returns false if a push for this PO is already running (no double-start). */
export function claimPush(poFileId: string): boolean {
  if (activePushes.has(poFileId)) return false;
  activePushes.add(poFileId);
  return true;
}

export function releasePush(poFileId: string): void {
  activePushes.delete(poFileId);
}
