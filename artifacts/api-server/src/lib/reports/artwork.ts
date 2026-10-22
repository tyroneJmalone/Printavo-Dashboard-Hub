import type { ReportOrder } from "./dataset";

export type ArtworkCategory = "both" | "mockupOnly" | "breezyOnly" | "neither" | "unknown";
export const artworkMetrics = ["total", "breezy", "mockup", "both", "mockupOnly", "breezyOnly", "neither", "unknown"] as const;
export type ArtworkMetric = typeof artworkMetrics[number];
type Source = { printavo_id: string; extras?: unknown; extras_synced_at?: unknown; extras_stale?: boolean };
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Absence requires a complete, current snapshot. Positive evidence is preserved
 * even when the snapshot is incomplete, but exclusive categories fail closed. */
export function artworkEvidence(source?: Source) {
  const extras = record(source?.extras);
  const files = Array.isArray(extras.productionFiles) ? extras.productionFiles : [];
  const items = Array.isArray(extras.lineItems) ? extras.lineItems : [];
  const filenames = files.map(f => record(f).name).filter((n): n is string => typeof n === "string" && /\.breezy$/i.test(n.trim()));
  const mockup = items.some(li => Array.isArray(record(li).mockups) && (record(li).mockups as unknown[]).some(m => !!record(m).id));
  const reasons: string[] = [];
  if (!source?.extras_synced_at) reasons.push("File details have not been synced");
  if (source?.extras_stale) reasons.push("File details are awaiting refresh");
  if (!Array.isArray(extras.productionFiles) || !Array.isArray(extras.lineItems)) reasons.push("File or line-item details are missing");
  if (extras.truncated === true) reasons.push("Snapshot was truncated");
  if (Array.isArray(extras.partialErrors) && extras.partialErrors.length) reasons.push("Snapshot contains partial API errors");
  if (files.some(f => !record(f).id || typeof record(f).name !== "string") ||
      items.some(li => !record(li).id || !Array.isArray(record(li).mockups) ||
        (record(li).mockups as unknown[]).some(m => !record(m).id))) reasons.push("Attachment details are incomplete");
  const complete = reasons.length === 0;
  const breezy = filenames.length > 0;
  const category: ArtworkCategory = !complete ? "unknown" : breezy && mockup ? "both" : breezy ? "breezyOnly" : mockup ? "mockupOnly" : "neither";
  return { breezy, mockup, complete, category, filenames, warning: reasons.join("; ") };
}

export function artworkMatches(row: { breezy: boolean; mockup: boolean; category: ArtworkCategory }, metric: ArtworkMetric) {
  return metric === "total" || (metric === "breezy" ? row.breezy : metric === "mockup" ? row.mockup : row.category === metric);
}

export function buildArtworkReport(orders: ReportOrder[], sources: Source[], metric: ArtworkMetric, month: string | undefined, offset: number, limit: number) {
  const sourceById = new Map(sources.map(s => [s.printavo_id, s]));
  const rows = [...new Map(orders.filter(o => o.orderType === "invoice").map(o => [o.id, o])).values()]
    .map(o => ({ id: o.id, visualId: o.visualId, customer: o.customerName ?? "", nickname: o.nickname ?? "",
      status: o.statusName ?? "", invoiceDate: o.invoiceAt?.slice(0, 10) ?? null,
      ...artworkEvidence(sourceById.get(o.id)) }))
    .sort((a,b) => (b.invoiceDate ?? "").localeCompare(a.invoiceDate ?? "") || b.visualId - a.visualId || a.id.localeCompare(b.id));
  const counts = (list: typeof rows) => Object.fromEntries(artworkMetrics.map(key => [key, list.filter(r => artworkMatches(r, key)).length])) as Record<ArtworkMetric, number>;
  const months = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.invoiceDate?.slice(0, 7) ?? "undated";
    const group = months.get(key) ?? [];
    group.push(row); months.set(key, group);
  }
  const selected = rows.filter(r => artworkMatches(r, metric) && (!month || (r.invoiceDate?.slice(0,7) ?? "undated") === month));
  const summary = counts(rows);
  const completeMockups = rows.filter(r => r.complete && r.mockup);
  return { summary,
    breezyPercent: summary.total ? 100 * summary.breezy / summary.total : null,
    breezyOfMockupsPercent: completeMockups.length ? 100 * completeMockups.filter(r => r.breezy).length / completeMockups.length : null,
    monthly: [...months].sort(([a],[b]) => b.localeCompare(a)).map(([month, list]) => ({ month, ...counts(list) })),
    invoices: selected.slice(offset, offset + limit), total: selected.length, offset, limit };
}
