/** Scheduler-only safety gate; manual starts remain explicit operator actions. */
export function scheduledAutoPrintAllowed(
  dryRun: boolean,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  return nodeEnv !== "development" || dryRun;
}