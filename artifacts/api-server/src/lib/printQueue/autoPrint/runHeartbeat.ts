export const RUN_HEARTBEAT_MS = 30_000;
export const RUN_STALE_MS = 2 * 60_000;

/** Long-running discovery/rendering is active as long as its worker is alive. */
export function abandonedRun(run: { status: string; updatedAt: Date }, now: Date) {
  return run.status === "running" && now.getTime() - run.updatedAt.getTime() > RUN_STALE_MS;
}

export function startRunHeartbeat(write: () => Promise<void>, failed: (err: unknown) => void) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await write(); } catch (err) { failed(err); } finally { busy = false; }
  }, RUN_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
