/** Pure guide logic for Guided Chipply Setup. Hub facts and user confirmations stay separate. */
export interface SetupChecks {
  storeName: string; eventId: string | null; customerLinked: boolean; closedAt: string | null;
  invoiceCount: number; incompleteInvoiceCount: number; missingCategoryCount: number; marginRowCount: number;
  snapshotId: string | null; orderCount: number; quantity: number; itemTotalCents: number; outcomes: Record<string, number>;
  /** Outstanding Store Summary differences; 0 when no summary uploaded (summary is optional). */
  summaryConflictCount?: number;
}
export interface SetupState { confirmedSteps: number[]; marginSkipped: boolean; checks: SetupChecks }
export interface Fact { label: string; ok: boolean; detail?: string }
export interface StepDef { n: number; title: string; short: string; optional?: boolean; confirm?: string }

export const RESOLVED_OUTCOMES = new Set(["matched", "reviewed"]);
export const STEPS: StepDef[] = [
  { n: 1, title: "Store identity", short: "Identity" },
  { n: 2, title: "Customer and close date", short: "Customer / dates", confirm: "I checked the linked customer is the right organization" },
  { n: 3, title: "Verify Printavo invoices", short: "Invoices", confirm: "I checked each invoice against the list above and they belong to this store" },
  { n: 4, title: "Sync Printavo", short: "Sync" },
  { n: 5, title: "Detailed Chipply export", short: "Detailed export", confirm: "I checked these totals match the Chipply portal for this store" },
  { n: 6, title: "Reconcile rows to invoices", short: "Reconcile" },
  { n: 7, title: "Invoice categories", short: "Categories", confirm: "I reviewed the assigned categories on these invoices and they are correct" },
  { n: 8, title: "Margin report", short: "Margins", optional: true },
  { n: 9, title: "Final checks", short: "Final", confirm: "I reviewed the final checks for this store" },
];
/** User confirmations required before the final confirmation unlocks. */
export const REQUIRED_CONFIRMS = [2, 3, 5, 7];

export const unresolvedCount = (o: Record<string, number>) =>
  Object.entries(o).filter(([k]) => !RESOLVED_OUTCOMES.has(k)).reduce((a, [, v]) => a + v, 0);

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function factsFor(n: number, s: SetupState): Fact[] {
  const c = s.checks;
  switch (n) {
    case 1: return [{ label: "Store name", ok: !!c.storeName.trim(), detail: c.storeName }, { label: "Chipply event number", ok: !!c.eventId, detail: c.eventId ?? "Not linked" }];
    case 2: return [{ label: "A Printavo customer is linked (accuracy needs your confirmation)", ok: c.customerLinked }, { label: "Closed date", ok: !!c.closedAt, detail: c.closedAt ?? "Missing" }];
    case 3: return [{ label: "Invoices found for event", ok: c.invoiceCount > 0, detail: String(c.invoiceCount) }];
    case 4: return [{ label: "Invoice details fully synced", ok: c.invoiceCount > 0 && c.incompleteInvoiceCount === 0, detail: `${c.incompleteInvoiceCount} incomplete` }];
    case 5: return [{ label: "Current detailed snapshot", ok: !!c.snapshotId, detail: c.snapshotId ? `${c.orderCount} orders · ${c.quantity} units · ${usd(c.itemTotalCents)}` : "None" }];
    case 6: return [{ label: "No unresolved rows", ok: !!c.snapshotId && unresolvedCount(c.outcomes) === 0, detail: c.snapshotId ? `${unresolvedCount(c.outcomes)} unresolved` : "Needs snapshot" }];
    case 7: return [{ label: "No lines missing a category (not a correctness check)", ok: c.invoiceCount > 0 && c.missingCategoryCount === 0, detail: `${c.missingCategoryCount} missing` }];
    case 8: return [{ label: "Margin report resolved (imported or skipped)", ok: c.marginRowCount > 0 || s.marginSkipped, detail: c.marginRowCount ? `${c.marginRowCount} rows` : s.marginSkipped ? "Skipped" : "Not imported" }];
    default: return [...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((k) => factsFor(k, s)), { label: "No outstanding Store Summary differences (summary optional)", ok: (c.summaryConflictCount ?? 0) === 0, detail: `${c.summaryConflictCount ?? 0} unresolved` }];
  }
}
export const factsOk = (n: number, s: SetupState) => factsFor(n, s).every((f) => f.ok);
export const allFactsOk = (s: SetupState) => factsOk(9, s);
export const priorConfirmed = (s: SetupState) => REQUIRED_CONFIRMS.every((k) => s.confirmedSteps.includes(k));
export const canConfirm = (n: number, s: SetupState) => n === 9 ? allFactsOk(s) && priorConfirmed(s) : factsOk(n, s);
export function stepSatisfied(n: number, s: SetupState) {
  const def = STEPS[n - 1];
  if (n === 9) return isComplete(s);
  return factsOk(n, s) && (!def.confirm || s.confirmedSteps.includes(n));
}
export const isComplete = (s: SetupState) => allFactsOk(s) && priorConfirmed(s) && s.confirmedSteps.includes(9);
export function nextAttention(view: number, s: SetupState): StepDef | undefined {
  return STEPS.find((d) => d.n > view && !stepSatisfied(d.n, s)) ?? STEPS.find((d) => d.n !== view && !stepSatisfied(d.n, s));
}
export function toggleConfirmed(list: number[], n: number): number[] {
  return list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b);
}
/**
 * Local notes follow server notes only when the user has no unsaved edit
 * (local still equals the last server value they saw).
 */
export function syncNotes(local: string, lastServer: string, incoming: string): string {
  return local === lastServer ? incoming : local;
}
