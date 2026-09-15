export interface AutoPrintIdentity {
  orderId: string;
  visualId: number;
}

export interface AutoPrintCandidatePlan<T> {
  selected: T[];
  alreadyPrinted: number;
  deferred: number;
}

/**
 * History dedup and the per-run detail cap deliberately happen before any
 * detail fetch. Keeping this pure makes the expensive-work ordering
 * executable in focused tests without touching PrintNode or the database.
 */
export function planAutoPrintDetails<T>(
  orders: readonly T[],
  identityOf: (order: T) => AutoPrintIdentity,
  printedIds: ReadonlySet<string>,
  printedVisuals: ReadonlySet<string>,
  maxOrders: number,
): AutoPrintCandidatePlan<T> {
  const unprinted: T[] = [];
  let alreadyPrinted = 0;
  for (const order of orders) {
    const identity = identityOf(order);
    if (
      printedIds.has(identity.orderId) ||
      printedVisuals.has(String(identity.visualId))
    ) {
      alreadyPrinted += 1;
      continue;
    }
    unprinted.push(order);
  }
  const selected = unprinted.slice(0, Math.max(0, maxOrders));
  return {
    selected,
    alreadyPrinted,
    deferred: Math.max(0, unprinted.length - selected.length),
  };
}