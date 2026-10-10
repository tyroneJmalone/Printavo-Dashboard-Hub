import { method, type DataLine } from "./dataImport";

export interface MirrorInvoice {
  invoiceId: string; visualId?: number | null; nickname: string; statusName: string | null;
  detailSyncState: string; detailSyncedAt: string | null; syncedAt: string | null;
  items: { style: string; color: string; quantity: number; sizes: { size: string; count: number }[] }[];
}
export interface Reconciliation {
  outcome: "matched" | "reviewed" | "ambiguous" | "quantity-mismatch" | "incomplete" | "unmatched" | "unverified";
  actualMethod: string | null; invoiceId: string | null; candidateInvoiceIds: string[]; reason: string;
  invoiceVisualId: number | null; candidateInvoices: { invoiceId: string; visualId: number | null }[];
}
export interface DataOverride { rowOrdinal: number; invoiceId: string; reason: string; actor: string; createdAt: string }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const size = (s: string) => {
  const normalized = norm(s.replace(/^size_/i, ""));
  return ({ xs: "xs", xsmall: "xs", small: "s", medium: "m", large: "l", xlarge: "xl", xxlarge: "2xl", xxl: "2xl", xxxlarge: "3xl", xxxl: "3xl" }[normalized] ?? normalized);
};
export function processSuffix(s: string): string { return norm(s.slice(s.indexOf(":") + 1)); }
const methodToken = /^(?:PRINT|SP|SCREEN|SCREENPRINT|HEAT|DTF|EMB|EMBROIDERY|DTG|TRANSFER|ENGRAVED|ENGRAVING)$/i;
function invoiceProcess(nickname: string): { event: string; suffix: string } | null {
  const colon = nickname.indexOf(":");
  if (colon < 0) return null;
  // The first colon must follow the sole decoration token in the header.
  // Never scan through an arbitrary earlier colon to find a later METHOD:.
  const header = nickname.slice(0, colon).trim().match(/^(\d{5,7})\s+(.+)\s+(\S+)$/);
  if (!header || !methodToken.test(header[3])) return null;
  if (header[2].split(/\s+/).some(token => methodToken.test(token))) return null;
  const suffix = nickname.slice(colon + 1).trim();
  if (!suffix || suffix.split(":").slice(0, -1).some(part => methodToken.test(part.trim()))) return null;
  return { event: header[1], suffix: norm(suffix) };
}
function sameProcess(line: DataLine, invoice: MirrorInvoice, event: string): boolean {
  const sourceColon = line.processName.indexOf(":");
  if (sourceColon < 0 || !methodToken.test(line.processName.slice(0, sourceColon).trim())) return false;
  const match = invoiceProcess(invoice.nickname);
  return !!match && match.event === event && match.suffix === processSuffix(line.processName);
}
function quantities(lines: DataLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) { const k = `${norm(l.style)}|${norm(l.color)}|${size(l.size)}`; m.set(k, (m.get(k) ?? 0) + l.quantity); }
  return m;
}
// Printavo has no dedicated OSFA/Adjustable size enum. Only interpret Other
// from unambiguous same-style/color one-size source evidence, never as apparel.
const oneSizeLabels = new Set(["osfa", "osfm", "os", "onesize", "onesizefitsall", "onesizefitsmost", "adjustable"]);
function oneSizeEvidence(lines: DataLine[], items: MirrorInvoice["items"]): Map<string, string> {
  const labels = new Map<string, Set<string>>();
  for (const line of lines) {
    const key = `${norm(line.style)}|${norm(line.color)}`;
    const values = labels.get(key) ?? new Set<string>();
    values.add(size(line.size)); labels.set(key, values);
  }
  const result = new Map<string, string>();
  for (const [key, values] of labels) {
    const [label] = [...values];
    if (values.size !== 1 || !oneSizeLabels.has(label) || key.startsWith("|") || key.endsWith("|")) continue;
    const matching = items.filter(item => `${norm(item.style)}|${norm(item.color)}` === key);
    if (matching.length && matching.every(item => Array.isArray(item.sizes) &&
      item.sizes.every(s => !Number(s.count) || (typeof s.size === "string" && size(s.size) === "other")))) result.set(key, label);
  }
  return result;
}
export interface QuantityComparison {
  state: "matched" | "different" | "incomplete" | "stale";
  rows: { style: string; color: string; size: string; expected: number; actual: number; delta: number;
    result: "matched" | "missing" | "extra" | "different" }[];
  issues: string[];
  oneSizeNotes: string[];
}
/** The same normalized combination comparison powers diagnostics and verification. */
export function compareQuantities(lines: DataLine[], invoice: MirrorInvoice): QuantityComparison {
  const expected = quantities(lines);
  const actual = new Map<string, number>();
  const issues: string[] = [];
  const oneSize = oneSizeEvidence(lines, invoice.items);
  const stale = invoice.detailSyncState !== "complete" || !invoice.detailSyncedAt ||
    !Number.isFinite(new Date(invoice.detailSyncedAt).getTime()) ||
    (invoice.syncedAt && (!Number.isFinite(new Date(invoice.syncedAt).getTime()) ||
      new Date(invoice.detailSyncedAt) < new Date(invoice.syncedAt)));
  for (const [index, item] of invoice.items.entries()) {
    const label = `Line ${index + 1} (${item.style || "missing style"} / ${item.color || "missing color"})`;
    const productKey = `${norm(item.style)}|${norm(item.color)}`;
    if (!norm(item.style) || !norm(item.color)) issues.push(`${label}: incomplete product identity.`);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) issues.push(`${label}: invalid line quantity.`);
    if (!Array.isArray(item.sizes)) { issues.push(`${label}: missing size breakdown.`); continue; }
    if (item.sizes.reduce((n, s) => n + Number(s.count), 0) !== item.quantity)
      issues.push(`${label}: size counts do not sum to line quantity ${item.quantity}.`);
    for (const entry of item.sizes) {
      // Printavo unused size slots may be null (zero), as in existing verification.
      const count = Number(entry.count);
      if (!Number.isSafeInteger(count) || count < 0) { issues.push(`${label}: invalid count for ${entry.size}.`); continue; }
      if (!count) continue;
      if (typeof entry.size !== "string" || !size(entry.size)) { issues.push(`${label}: missing size label.`); continue; }
      const normalized = size(entry.size);
      const key = `${productKey}|${normalized === "other" ? oneSize.get(productKey) ?? normalized : normalized}`;
      actual.set(key, (actual.get(key) ?? 0) + count);
    }
  }
  const rows: QuantityComparison["rows"] = [...new Set([...expected.keys(), ...actual.keys()])].sort().map(key => {
    const [style, color, size] = key.split("|");
    const e = expected.get(key) ?? 0, a = actual.get(key) ?? 0;
    return { style, color, size, expected: e, actual: a, delta: a - e,
      result: a === e ? "matched" : !actual.has(key) ? "missing" : !expected.has(key) ? "extra" : "different" };
  });
  return { state: stale ? "stale" : issues.length ? "incomplete" : rows.some(r => r.result !== "matched") ? "different" : "matched",
    rows, issues, oneSizeNotes: [...oneSize].map(([key, label]) => `${key.replace("|", " / ")}: Printavo Other interpreted as ${label} from this product's sole Chipply one-size label.`) };
}
export function compareProcesses(lines: DataLine[], event: string, invoices: MirrorInvoice[]) {
  const groups = new Map<string, DataLine[]>();
  for (const line of lines) {
    const key = processSuffix(line.processName);
    const group = groups.get(key) ?? [];
    group.push(line); groups.set(key, group);
  }
  return [...groups].map(([processKey, group]) => {
    const candidates = invoices.filter(invoice => group.some(line => sameProcess(line, invoice, event)));
    return { processKey, processNames: [...new Set(group.map(l => l.processName))],
      state: candidates.length > 1 ? "ambiguous" as const : candidates.length ? "single" as const : "unmatched" as const,
      candidates: candidates.map(invoice => ({ invoiceId: invoice.invoiceId, visualId: invoice.visualId ?? null,
        detailSyncedAt: invoice.detailSyncedAt, sourceUpdatedAt: invoice.syncedAt,
        ...compareQuantities(group, invoice) })) };
  });
}
export function reconcileData(lines: DataLine[], event: string, invoices: MirrorInvoice[], overrides: DataOverride[] = []): (DataLine & { reconciliation: Reconciliation })[] {
  return lines.map(line => {
    const candidates = invoices.filter(i => sameProcess(line, i, event));
    const base: Reconciliation = { outcome: "unmatched", actualMethod: null, invoiceId: null, invoiceVisualId: null,
      candidateInvoices: candidates.map(i => ({ invoiceId: i.invoiceId, visualId: i.visualId ?? null })),
      candidateInvoiceIds: candidates.map(i => i.invoiceId), reason: "No same-event process suffix match" };
    const override = overrides.find(o => o.rowOrdinal === line.rowOrdinal);
    const chosen = override ? candidates.find(i => i.invoiceId === override.invoiceId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!chosen) {
      if (candidates.length > 1) { base.outcome = "ambiguous"; base.reason = "Multiple same-process invoices; review required"; }
      return { ...line, reconciliation: base };
    }
    const processLines = lines.filter(l => processSuffix(l.processName) === processSuffix(line.processName));
    const comparison = compareQuantities(processLines, chosen);
    if (comparison.state === "stale" || comparison.state === "incomplete") {
      return { ...line, reconciliation: { ...base, outcome: "incomplete", reason: "Complete current mirrored quantity details required" } };
    }
    if (comparison.state === "different")
      return { ...line, reconciliation: { ...base, outcome: "quantity-mismatch", reason: "Style/color/size quantities do not cover the complete source process group" } };
    const statusMethod = method(chosen.statusName ?? "");
    const nicknameMethod = method(chosen.nickname.split(":")[0].split(/\s+/).pop() ?? "");
    const statusTokens = new Set((chosen.statusName ?? "").split(/[\s:/+,&-]+/).map(method).filter(Boolean));
    // An explicit MERCH MIXED stage is an authoritative, distinct method.
    // A status merely listing PRINT + HEAT is ambiguous, not that stage.
    const explicitMixed = /\bMERCH\s*-?\s*MIXED(?:\s+DECO(?:RATION)?)?\b/i.test(chosen.statusName ?? "");
    const ambiguous = statusTokens.size > 1 || /\b(mixed|multiple)\b/i.test(chosen.statusName ?? "");
    const actualMethod = explicitMixed ? "mixed-decoration" : ambiguous ? null : statusMethod ?? nicknameMethod;
    return { ...line, reconciliation: { ...base, outcome: actualMethod ? override ? "reviewed" : "matched" : "unverified", actualMethod, invoiceId: chosen.invoiceId, invoiceVisualId: chosen.visualId ?? null, reason: actualMethod ? `${statusMethod || explicitMixed ? "Current mirrored status" : "Nickname fallback"}; full quantities verified${comparison.oneSizeNotes.length ? "; one-size labels reconciled with Printavo Other for matching products/colors" : ""}${override ? "; reviewed invoice selection" : ""}` : "No unambiguous production method evidence" } };
  });
}