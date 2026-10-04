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
      item.sizes.every(s => !Number(s.count) || size(s.size) === "other"))) result.set(key, label);
  }
  return result;
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
    if (chosen.detailSyncState !== "complete" || !chosen.detailSyncedAt || (chosen.syncedAt && new Date(chosen.detailSyncedAt) < new Date(chosen.syncedAt))) {
      return { ...line, reconciliation: { ...base, outcome: "incomplete", reason: "Complete current mirrored quantity details required" } };
    }
    const processLines = lines.filter(l => processSuffix(l.processName) === processSuffix(line.processName));
    const expected = quantities(processLines);
    const oneSize = oneSizeEvidence(processLines, chosen.items);
    const actual = new Map<string, number>();
    let complete = true;
    for (const item of chosen.items) {
      if (!Array.isArray(item.sizes) || item.sizes.reduce((n, s) => n + Number(s.count), 0) !== item.quantity) { complete = false; break; }
      for (const s of item.sizes) {
        if (!Number.isSafeInteger(Number(s.count)) || Number(s.count) < 0) { complete = false; break; }
        if (!Number(s.count)) continue;
        const productKey = `${norm(item.style)}|${norm(item.color)}`;
        const normalizedSize = size(s.size);
        const k = `${productKey}|${normalizedSize === "other" ? oneSize.get(productKey) ?? normalizedSize : normalizedSize}`;
        actual.set(k, (actual.get(k) ?? 0) + Number(s.count));
      }
    }
    if (!complete || actual.size !== expected.size || [...expected].some(([k, v]) => actual.get(k) !== v))
      return { ...line, reconciliation: { ...base, outcome: "quantity-mismatch", reason: "Style/color/size quantities do not cover the complete source process group" } };
    const statusMethod = method(chosen.statusName ?? "");
    const nicknameMethod = method(chosen.nickname.split(":")[0].split(/\s+/).pop() ?? "");
    const statusTokens = new Set((chosen.statusName ?? "").split(/[\s:/+,&-]+/).map(method).filter(Boolean));
    // An explicit MERCH MIXED stage is an authoritative, distinct method.
    // A status merely listing PRINT + HEAT is ambiguous, not that stage.
    const explicitMixed = /\bMERCH\s*-?\s*MIXED(?:\s+DECO(?:RATION)?)?\b/i.test(chosen.statusName ?? "");
    const ambiguous = statusTokens.size > 1 || /\b(mixed|multiple)\b/i.test(chosen.statusName ?? "");
    const actualMethod = explicitMixed ? "mixed-decoration" : ambiguous ? null : statusMethod ?? nicknameMethod;
    return { ...line, reconciliation: { ...base, outcome: actualMethod ? override ? "reviewed" : "matched" : "unverified", actualMethod, invoiceId: chosen.invoiceId, invoiceVisualId: chosen.visualId ?? null, reason: actualMethod ? `${statusMethod || explicitMixed ? "Current mirrored status" : "Nickname fallback"}; full quantities verified${oneSize.size ? "; one-size labels reconciled with Printavo Other for matching products/colors" : ""}${override ? "; reviewed invoice selection" : ""}` : "No unambiguous production method evidence" } };
  });
}