import { createHash } from "node:crypto";
import { parseCsvRows } from "./parseCsv";

export interface SummarySource {
  eventId: string; storeName: string; storeType: string; status: string | null;
  openedAt: string | null; closedAt: string | null; productionDueAt: string | null; shipAt: string | null;
  contact: string | null; salesperson: string | null; orders: number | null; sales: string | null;
  processes: number | null; processesWithOrders: number | null;
}
export const summaryFields = [
  { field: "storeName", column: "store_name", label: "Store name" },
  { field: "openedAt", column: "opened_at", label: "Open date" },
  { field: "closedAt", column: "closed_at", label: "Close date" },
  { field: "contact", column: "org_contact", label: "Contact" },
  { field: "salesperson", column: "salesperson", label: "Salesperson" },
  { field: "orders", column: "num_orders", label: "Order count" },
] as const;
export type SummaryComparison = {
  field: string; label: string; current: string | number | null; incoming: string | number | null;
  action: "fill" | "conflict" | "same" | "source" | "retained"; evidenceKey: string;
};
export const summaryHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const blank = (value: unknown) => value == null || typeof value === "string" && value.trim() === "";
export const supportedSummary = (s: SummarySource) => s.storeType === "Group" && /^\d{5,7}$/.test(s.eventId);
export function summaryComparisons(source: SummarySource, store: Record<string, any> | null, retained: Record<string, { evidenceKey: string }> = {}): SummaryComparison[] {
  const fields: SummaryComparison[] = summaryFields.map(({ field, column, label }) => {
    const current = store?.[column] ?? null, incoming = source[field];
    const evidenceKey = summaryHash([source.eventId, field, current, incoming]);
    const action = blank(incoming) || current === incoming ? "same" : blank(current) ? "fill" : retained[field]?.evidenceKey === evidenceKey ? "retained" : "conflict";
    return { field, label, current, incoming, action, evidenceKey };
  });
  for (const [field, label] of Object.entries({
    status: "Chipply status (source only)", storeType: "Store type (source only)",
    productionDueAt: "Production due date (source only)", shipAt: "Ship date (source only)",
    sales: "Reported sales (definition unverified)", processes: "Processes (source only)", processesWithOrders: "Processes with orders (source only)",
  })) fields.push({ field, label, current: null, incoming: source[field as keyof SummarySource], action: "source", evidenceKey: summaryHash([field, source[field as keyof SummarySource]]) });
  return fields;
}

export function parseSummaryCsv(text: string): SummarySource[] {
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new Error("CSV must be at most 2 MB");
  // Reject unbalanced CSV quotes rather than accepting a silently truncated field.
  let quoted = false;
  for (let i = 0; i < text.length; i++) if (text[i] === '"') {
    if (quoted && text[i + 1] === '"') i++; else quoted = !quoted;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted cell");
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const headers = rows.shift()?.map(h => h.trim().toLowerCase()) ?? [];
  const required = ["sales order", "status", "open date", "close date", "production due date", "ship date", "name", "type", "contact", "salesperson", "orders", "sales", "processes", "processes with orders"];
  for (const name of required) if (headers.filter(h => h === name).length !== 1) throw new Error(`Expected exactly one "${name}" column. Use the Store Summary grid CSV, not a SalesReport or detailed export.`);
  const result: SummarySource[] = [], ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.every(c => !c.trim())) continue;
    if (result.length >= 2000) throw new Error("Maximum 2,000 summary rows per upload");
    if (row.length !== headers.length) throw new Error(`Row ${index + 2}: column count does not match header`);
    const get = (name: string) => {
      const value = row[headers.indexOf(name)].trim();
      if (value.length > 500) throw new Error(`Row ${index + 2}: ${name} is too long`);
      return value || null;
    };
    const integer = (name: string) => {
      const raw = get(name);
      if (raw === null) return null;
      if (!/^\d+$/.test(raw) || Number(raw) > 2147483647) throw new Error(`Row ${index + 2}: invalid ${name}`);
      return Number(raw);
    };
    const date = (name: string) => {
      const raw = get(name);
      if (!raw) return null;
      const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) throw new Error(`Row ${index + 2}: ${name} must be M/D/YYYY`);
      const [, m, d, y] = match;
      const key = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      const value = new Date(`${key}T00:00:00Z`);
      if (Number(y) < 1900 || !Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== key) throw new Error(`Row ${index + 2}: invalid ${name}`);
      return key;
    };
    const eventId = get("sales order"), storeName = get("name"), storeType = get("type");
    if (!eventId || !/^[A-Za-z0-9-]{1,40}$/.test(eventId) || !storeName || !storeType) throw new Error(`Row ${index + 2}: Sales Order, Name and Type are required`);
    if (ids.has(eventId)) throw new Error(`Duplicate Sales Order ${eventId}; resolve duplicate rows before importing`);
    ids.add(eventId);
    const rawSales = get("sales");
    let sales: string | null = null;
    if (rawSales !== null) {
      if (!/^\$?-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(rawSales)) throw new Error(`Row ${index + 2}: invalid Sales amount`);
      const value = Number(rawSales.replace(/[$,]/g, ""));
      if (!Number.isFinite(value) || Math.abs(value) >= 1e10) throw new Error(`Row ${index + 2}: Sales out of range`);
      sales = value.toFixed(2);
    }
    const source: SummarySource = {
      eventId, storeName, storeType, status: get("status"), openedAt: date("open date"), closedAt: date("close date"),
      productionDueAt: date("production due date"), shipAt: date("ship date"), contact: get("contact"), salesperson: get("salesperson"),
      orders: integer("orders"), sales, processes: integer("processes"), processesWithOrders: integer("processes with orders"),
    };
    if (source.openedAt && source.closedAt && source.openedAt > source.closedAt) throw new Error(`Row ${index + 2}: close date precedes open date`);
    if (source.processes != null && source.processesWithOrders != null && source.processesWithOrders > source.processes) throw new Error(`Row ${index + 2}: processes with orders exceeds processes`);
    result.push(source); // Password and unknown columns deliberately never retained.
  }
  if (!result.length) throw new Error("CSV contains no store rows");
  return result;
}