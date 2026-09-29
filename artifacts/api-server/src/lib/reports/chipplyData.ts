/** Pure line-level reporting. Never join order fees onto product rows. */
export interface ChipplyReportLine {
  storeId: string;
  storeName: string;
  eventId: string | null;
  customer: string | null;
  closedAt: string | null;
  transactionDate: string | null;
  rowOrdinal: number;
  orderNumber: string;
  processName: string | null;
  plannedMethod: string | null;
  actualMethod: string | null;
  methodChanged: boolean | null;
  outcome: string;
  reason: string | null;
  invoiceId: string | null;
  status: string | null;
  nickname: string | null;
  vendor: string | null;
  product: string | null;
  style: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  itemTotalCents: number;
}
export interface ChipplyReportFilters {
  store?: string; customer?: string; plannedMethod?: string; actualMethod?: string;
  methodChanged?: string; outcome?: string; status?: string; vendor?: string;
  product?: string; style?: string; dateBasis?: string; start?: string; end?: string;
}
export function parseChipplyReportFilters(query: Record<string, unknown>): ChipplyReportFilters {
  const result: Record<string, string> = {};
  for (const key of ["store", "customer", "plannedMethod", "actualMethod", "methodChanged", "outcome", "status", "vendor", "product", "style", "dateBasis", "start", "end"]) {
    const value = query[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 250) throw new Error(`Invalid ${key}`);
    result[key] = value.trim();
  }
  if (result.dateBasis && !["closed", "transaction"].includes(result.dateBasis)) throw new Error("Invalid dateBasis");
  if (result.methodChanged && !["yes", "no", "unallocated"].includes(result.methodChanged)) throw new Error("Invalid methodChanged");
  for (const key of ["start", "end"]) {
    if (result[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(result[key]) || !Number.isFinite(Date.parse(result[key])) || new Date(result[key]).toISOString().slice(0, 10) !== result[key])) throw new Error(`Invalid ${key} date`);
  }
  if (result.start && result.end && result.start > result.end) throw new Error("Start date must precede end date");
  return { dateBasis: "closed", ...result };
}
const contains = (value: string | null, filter?: string) => !filter || (value ?? "").toLowerCase().includes(filter.toLowerCase());
export function filterChipplyLines(lines: ChipplyReportLine[], f: ChipplyReportFilters): ChipplyReportLine[] {
  return lines.filter((r) => {
    const date = f.dateBasis === "transaction" ? r.transactionDate : r.closedAt;
    return contains(`${r.storeName} ${r.eventId ?? ""}`, f.store)
      && contains(r.customer, f.customer)
      && contains(r.plannedMethod, f.plannedMethod)
      && (!f.actualMethod || (r.actualMethod ?? "Unallocated").toLowerCase() === f.actualMethod.toLowerCase())
      && (!f.outcome || r.outcome.toLowerCase() === f.outcome.toLowerCase())
      && contains(r.status, f.status)
      && contains(r.vendor, f.vendor) && contains(r.product, f.product) && contains(r.style, f.style)
      && (!f.methodChanged || (r.methodChanged === null ? "unallocated" : r.methodChanged ? "yes" : "no") === f.methodChanged)
      && (!f.start || (!!date && date.slice(0, 10) >= f.start))
      && (!f.end || (!!date && date.slice(0, 10) <= f.end));
  });
}
export function summarizeChipplyLines(lines: ChipplyReportLine[]) {
  return {
    lineCount: lines.length,
    storeCount: new Set(lines.map(r => r.storeId)).size,
    orderCount: new Set(lines.map(r => `${r.storeId}:${r.orderNumber}`)).size,
    quantity: lines.reduce((sum, r) => sum + r.quantity, 0),
    itemTotalCents: lines.reduce((sum, r) => sum + r.itemTotalCents, 0),
    unallocatedItemTotalCents: lines.filter(r => !r.actualMethod).reduce((sum, r) => sum + r.itemTotalCents, 0),
  };
}
export function chipplyReportCsv(lines: ChipplyReportLine[]): string {
  const columns: (keyof ChipplyReportLine)[] = ["storeId", "storeName", "eventId", "customer", "closedAt", "transactionDate", "orderNumber", "rowOrdinal", "plannedMethod", "actualMethod", "methodChanged", "outcome", "reason", "invoiceId", "status", "nickname", "vendor", "product", "style", "color", "size", "quantity", "itemTotalCents"];
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [columns.join(","), ...lines.map(row => columns.map(key => cell(key === "actualMethod" ? row[key] ?? "Unallocated" : row[key])).join(","))].join("\r\n");
}