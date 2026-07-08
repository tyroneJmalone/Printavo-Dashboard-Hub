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
