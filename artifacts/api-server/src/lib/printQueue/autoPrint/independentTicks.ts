/** Retry I/O must not hold the daily-slot check's in-process guard. */
export function independentTicks(schedule: () => Promise<void>, retry: () => Promise<void>, error: (err: unknown) => void) {
  let scheduling = false, retrying = false;
  return () => {
    if (!scheduling) {
      scheduling = true;
      void schedule().catch(error).finally(() => { scheduling = false; });
    }
    if (!retrying) {
      retrying = true;
      void retry().catch(error).finally(() => { retrying = false; });
    }
  };
}
