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
