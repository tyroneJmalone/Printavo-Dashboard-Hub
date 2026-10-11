/** Database timestamps remain strings: JS Date would lose PostgreSQL microseconds. */
export interface AlertPosition { at: string; id: string }
export interface AlertCursor {
  after?: AlertPosition;
  /** Freeze a reconciliation cycle so a busy mutable tail cannot prevent wrapping. */
  through?: string;
  /** A run's jobs are paged independently; never checkpoint past an unfinished fanout. */
  run?: AlertPosition & { jobAfter?: string };
}
export const ALERT_BATCH_SIZE = 50;
export const ALERT_STREAMS = ["jobs", "attemptStarted", "attemptFinished", "runs", "activeJobs", "activeRuns"] as const;
export type AlertStream = typeof ALERT_STREAMS[number];
export interface AlertPage<T> { items: T[]; next: AlertCursor }

/** The adapter must hold a durable cursor lock and commit delivery + checkpoint in
 * one transaction. A thrown delivery aborts the page, including its checkpoint.
 * Reconciliation wraps to activation, not "now": arbitrarily late commits and
 * downtime are eventually covered without an unbounded query or historical replay.
 */
export async function collectAlertPage<T>(adapter: {
  read: () => Promise<AlertPage<T>>;
  deliver: (items: T[]) => Promise<void>;
  checkpoint: (cursor: AlertCursor) => Promise<void>;
}) {
  const page = await adapter.read();
  await adapter.deliver(page.items);
  await adapter.checkpoint(page.next);
}

export function nextAlertCursor(rows: AlertPosition[], previous: AlertCursor, reconcile: boolean): AlertCursor {
  if (!rows.length) return reconcile ? {} : previous;
  return { through: previous.through, after: rows[rows.length - 1] };
}
