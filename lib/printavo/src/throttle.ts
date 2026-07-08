export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes all requests through a single promise chain and enforces a
 * minimum interval between the END of one request and the START of the next.
 *
 * INVARIANT: this gate is in-process only. It is safe only while every
 * Printavo call in the account flows through ONE api-server process.
 */
export class RequestGate {
  private queue: Promise<void> = Promise.resolve();
  private lastRequestEndedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestEndedAt + this.minIntervalMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await fn();
      } finally {
        this.lastRequestEndedAt = Date.now();
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
