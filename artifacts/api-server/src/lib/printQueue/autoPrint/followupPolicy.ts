import { createHash } from "node:crypto";

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
