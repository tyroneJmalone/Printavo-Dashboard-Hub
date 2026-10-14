import { createHash } from "node:crypto";

/** Normalize only known invoice instants; never descriptions or calendar-date strings. */
export function normalizeFollowupDates<T>(node: T): T {
  const copy = structuredClone(node) as any;
  const instant = (v: unknown) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return v;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : v;
  };
  for (const key of ["productionDueAt", "customerDueAt"]) {
    if (Object.hasOwn(copy, key)) copy[key] = instant(copy[key]);
  }
  if (copy.timestamps) for (const key of ["createdAt", "updatedAt"]) {
    if (Object.hasOwn(copy.timestamps, key)) copy.timestamps[key] = instant(copy.timestamps[key]);
  }
  return copy;
}

/** Stored "complete" means the worker stopped, not that every invoice succeeded. */
export function followupDisplayState(state: string, invoices: { state: string }[]) {
  if (state !== "complete") return state;
  if (invoices.some(i => ["review_required", "blocked"].includes(i.state))) return "review_required";
  if (invoices.some(i => i.state === "status_queued")) return "status_queued";
  if (invoices.some(i => i.state === "recovery_started")) return "recovery_started";
  return invoices.length && invoices.every(i => ["updated", "noop"].includes(i.state)) ? "complete" : "review_required";
}

/** Canonical fingerprints ignore object-key order, never array membership/order. */
export function followupHash(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) :
    v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function followupEligibility(input: {
  accepted: boolean; dryRun: boolean; merch: boolean; recognized: boolean;
  currentStatusId: string | null; sourceStatusId: string | null;
  targetStatusId: string | null; complete: boolean;
}): string | null {
  if (!input.accepted || input.dryRun) return "Only confirmed, accepted workorders from live runs can be corrected.";
  if (!input.merch || !input.recognized) return "Only recognized MERCH invoices are supported.";
  if (!input.complete) return "Incomplete live invoice evidence; no changes allowed.";
  if (!input.targetStatusId) return "No destination matches the current saved rules.";
  if (!input.currentStatusId || (input.currentStatusId !== input.sourceStatusId && input.currentStatusId !== input.targetStatusId)) {
    return "Invoice has moved beyond the printed source status or into a different workflow. Review manually; it will not be moved backward.";
  }
  return null;
}
