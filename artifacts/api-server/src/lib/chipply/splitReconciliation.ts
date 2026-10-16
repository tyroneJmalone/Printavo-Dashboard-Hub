import { createHash } from "node:crypto";
import type { DataLine } from "./dataImport";
import { compareQuantities, invoiceMethod, processSuffix, sameProcess, type MirrorInvoice } from "./dataReconciliation";

// Stable across JSONB key ordering and unordered SQL aggregates.
export function evidenceHash(value: unknown): string {
  const canonical = (v: any): any => v instanceof Date ? v.toISOString()
    : Array.isArray(v) ? v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function compareSplit(lines: DataLine[], event: string, processKey: string, invoices: MirrorInvoice[], invoiceIds: string[]) {
  const group = lines.filter(l => processSuffix(l.processName) === processKey);
  const selected = invoices.filter(i => invoiceIds.includes(i.invoiceId));
  const issues: string[] = [];
  if (!group.length) issues.push("Source process not found.");
  if (invoiceIds.length < 2 || invoiceIds.length > 20 || new Set(invoiceIds).size !== invoiceIds.length)
    issues.push("Select 2–20 distinct invoices; repeated IDs are not allowed.");
  if (selected.length !== invoiceIds.length || selected.some(i => !group.every(l => sameProcess(l, i, event))))
    issues.push("Every selected invoice must match this event and complete process group.");
  const signatures = new Set<string>();
  for (const invoice of selected) {
    const check = compareQuantities(group, invoice);
    if (check.state === "incomplete" || check.state === "stale")
      issues.push(`Invoice ${invoice.visualId ?? invoice.invoiceId}: complete current mirror details required.`);
    if (!invoice.items.some(i => i.quantity > 0)) issues.push("Every selected invoice must contribute garments.");
    // Compare normalized quantity signatures, not line grouping or invoice IDs.
    const signature = evidenceHash(check.rows.filter(r => r.actual > 0).map(({ style, color, size, actual }) => ({ style, color, size, actual })));
    if (signatures.has(signature)) issues.push("Selected invoices have identical garment breakdowns; possible duplicates cannot be approved as a split.");
    signatures.add(signature);
  }
  const comparison = compareQuantities(group, {
    invoiceId: "combined", nickname: "", statusName: null, detailSyncState: "complete",
    detailSyncedAt: "2000-01-01T00:00:00Z", syncedAt: null, items: selected.flatMap(i => i.items),
  });
  if (comparison.state !== "matched") issues.push("Combined invoices must exactly cover every source style/color/size, with no missing or extra garments.");
  const methods = selected.map(i => invoiceMethod(i).actualMethod);
  const actualMethod = methods.length && methods.every(m => m && m === methods[0]) ? methods[0] : null;
  if (!actualMethod) issues.push("All selected invoices must have the same unambiguous production method; no inferred allocation across methods.");
  return { ...comparison, issues: [...comparison.issues, ...issues], eligible: !issues.length && comparison.state === "matched",
    actualMethod, invoices: selected.map(i => ({ invoiceId: i.invoiceId, visualId: i.visualId ?? null })) };
}
