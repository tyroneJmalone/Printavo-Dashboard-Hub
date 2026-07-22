let seedActive = false;
let pollActive = false;

export function isSeedActive(): boolean {
  return seedActive;
}

export function setSeedActive(value: boolean): void {
  seedActive = value;
}

export function isPollActive(): boolean {
  return pollActive;
}

export function setPollActive(value: boolean): void {
  pollActive = value;
}

let detailBackfillActive = false;

export function isDetailBackfillActive(): boolean {
  return detailBackfillActive;
}

export function setDetailBackfillActive(value: boolean): void {
  detailBackfillActive = value;
}

let paymentsSeedActive = false;

export function isPaymentsSeedActive(): boolean {
  return paymentsSeedActive;
}

export function setPaymentsSeedActive(value: boolean): void {
  paymentsSeedActive = value;
}

/**
 * History backfill (backup module B2). Unlike the other backfills the
 * incremental poll does NOT skip while this is active — the backfill
 * yields to polls instead (multi-hour run must not starve the 5-min
 * sync). It IS mutually exclusive with seed/detail/payments backfills.
 */
let historyBackfillActive = false;

export function isHistoryBackfillActive(): boolean {
  return historyBackfillActive;
}

export function setHistoryBackfillActive(value: boolean): void {
  historyBackfillActive = value;
}
