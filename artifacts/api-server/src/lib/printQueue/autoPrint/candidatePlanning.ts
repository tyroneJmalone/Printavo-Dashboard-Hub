import { createHash } from "node:crypto";

/** Whitelisted product fields only: status, ordered flags and timestamps never affect this baseline. */
export function lineItemFingerprint(lines: readonly Record<string, unknown>[]): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value ?? null;
  };
  const products = lines.map((line) => Object.fromEntries(
    ["id", "itemNumber", "color", "description", "items", "sizes", "product", "category", "price", "merch"]
      .map((key) => [key, line[key] ?? null]),
  ));
  return createHash("sha256").update(JSON.stringify(canonical(products))).digest("hex");
}

export function decideReprint(input: {
  prior: { contentFingerprint: string | null; printedAt: Date | null } | null;
  fingerprint: string;
  reentry: { id: number; occurredAt: Date } | null;
}): { allowed: boolean; isReprint: boolean; reason: string | null; cycle: string } {
  const { prior, fingerprint, reentry } = input;
  if (!prior) return { allowed: true, isReprint: false, reason: null, cycle: "initial" };
  const deny = (reason: string) => ({ allowed: false, isReprint: false, reason, cycle: "blocked" });
  if (!prior.contentFingerprint || !prior.printedAt) return deny("prior_print_baseline_missing");
  if (!reentry || reentry.occurredAt <= prior.printedAt) return deny("no_source_reentry_after_print");
  if (fingerprint === prior.contentFingerprint) return deny("line_items_unchanged");
  return { allowed: true, isReprint: true, reason: null, cycle: `entry:${reentry.id}` };
}

export function printAttemptKey(logicalOrder: string, cycle: string, fingerprint: string): string {
  return createHash("sha256").update(JSON.stringify([logicalOrder, cycle, fingerprint])).digest("hex");
}

/** Called under the database logical-order lock, with latest successful print first. */
export function canReservePrint(history: readonly { id: string; status: string }[], expectedPriorId: string | null): boolean {
  if (history.some((row) => ["pending", "retry_pending", "held", "exhausted", "cancelled", "submission_unknown"].includes(row.status))) return false;
  return (history.find((row) => row.status === "printed")?.id ?? null) === expectedPriorId;
}

/** Only known recorded status shapes are accepted; arbitrary objects never prove an exit. */
export function observedSourceMembership(value: unknown, statuses: readonly { id: string; name: string }[], sourceIds: ReadonlySet<string>, depth = 0): boolean | null {
  if (depth > 3 || value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (text.startsWith('"') || text.startsWith("{")) {
      try { return observedSourceMembership(JSON.parse(text), statuses, sourceIds, depth + 1); } catch { return null; }
    }
    const matches = statuses.filter((s) => s.id === text || s.name === text);
    const results = new Set(matches.map((s) => sourceIds.has(s.id)));
    return results.size === 1 ? [...results][0] : null;
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if ("status" in object) return observedSourceMembership(object.status, statuses, sourceIds, depth + 1);
  const id = object.id ?? object.statusId;
  const name = object.name ?? object.statusName;
  if (typeof id === "string" || typeof id === "number") {
    const status = statuses.find((s) => s.id === String(id));
    if (!status || (typeof name === "string" && name !== status.name)) return null;
    return sourceIds.has(status.id);
  }
  return typeof name === "string" ? observedSourceMembership(name, statuses, sourceIds, depth + 1) : null;
}

export interface ConversionEvidence {
  entityType: string; entityId: string; eventType: string; visualId: number | null;
  oldValue: unknown; newValue: unknown;
}

/** Visual identity alone is insufficient: require the sync engine's explicit conversion provenance. */
export function verifiedConversionOrderIds(order: AutoPrintIdentity, events: readonly ConversionEvidence[]): string[] {
  const ids = events.flatMap((event) => {
    if (event.entityType !== "order" || event.eventType !== "converted" ||
      event.entityId !== order.orderId || event.visualId !== order.visualId) return [];
    const old = event.oldValue as Record<string, unknown> | null;
    const next = event.newValue as Record<string, unknown> | null;
    if (!old || !next || old.orderType !== "quote" || next.orderType !== "invoice" ||
      typeof old.printavoId !== "string" || next.printavoId !== order.orderId ||
      old.printavoId === order.orderId || !old.customerId || old.customerId !== next.customerId) return [];
    return [old.printavoId];
  });
  const unique = [...new Set(ids)];
  return unique.length === 1 ? unique : [];
}

export function hubPoOrdersFromOutcomes(
  outcomes: readonly { candidate: AutoPrintIdentity & { isReprint?: boolean; priorPrintedAt?: Date | null }; outcome: string }[],
  conversions: readonly ConversionEvidence[],
) {
  return outcomes.filter((o) => o.outcome === "printed").map(({ candidate }) => ({
    orderId: candidate.orderId, visualId: candidate.visualId,
    ...(candidate.isReprint !== undefined ? {
      isReprint: candidate.isReprint,
      priorPrintedAt: candidate.priorPrintedAt ?? null,
    } : {}),
    verifiedSnapshotOrderIds: verifiedConversionOrderIds(candidate, conversions),
  }));
}

export function definitiveFailureCandidates<T>(outcomes: readonly { candidate: T; outcome: string; definitivePreSubmitFailure?: boolean }[]): T[] {
  return outcomes.filter((o) => o.outcome === "failed" && o.definitivePreSubmitFailure === true).map((o) => o.candidate);
}

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