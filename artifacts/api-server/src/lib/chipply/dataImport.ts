import { createHash } from "node:crypto";
import { parseCsvRows } from "./parseCsv";

export const MAX_DATA_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 10000;
export const unitFields = ["Product Cost", "Product Price", "Process Cost", "Process Price", "Combined", "Oversize Charge", "Fundraising", "Options Cost", "Options Price", "Item Price"] as const;
export const orderFields = ["Manual Adj Total", "Sub Total", "Tax Total", "Handling Total", "Shipping Total", "Promo Total", "E-Cert Total", "PO Total", "Payment Type Total", "Order Total", "Chipply Fees", "Credit Card Fees"] as const;
export interface DataLine {
  rowOrdinal: number; orderNumber: string; orderDate: string; processName: string;
  plannedMethod: string | null; style: string; color: string; size: string;
  productName: string; vendor: string; quantity: number; itemTotalCents: number;
  unitCents: Record<string, number>;
}
export interface DataSummary {
  lineCount: number; orderCount: number; quantity: number; itemTotalCents: number;
  orderTotalCents: number; orderComponentsCents: Record<string, number>;
  unitComponentsExtendedCents: Record<string, number>;
}
export interface ParsedData {
  salesOrder: string; storeName: string; sourceHash: string;
  summary: DataSummary; lines: DataLine[];
  orders: { orderNumber: string; componentsCents: Record<string, number> }[];
  safeHeaders: string[];
}
export function cleanCell(value: string): string {
  const s = value.trim();
  return /^="[^"]*"$/.test(s) ? s.slice(2, -1) : s;
}
export function cents(value: string): number {
  let s = cleanCell(value).replace(/[$,]/g, "");
  if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1);
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) throw new Error("Invalid or missing monetary value");
  const [whole, fraction = ""] = s.replace(/^-/, "").split(".");
  if (/[1-9]/.test(fraction.slice(2))) throw new Error("Sub-cent monetary precision is not supported");
  const n = (BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2))) * (s.startsWith("-") ? -1n : 1n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("Money exceeds supported range");
  return Number(n);
}
export function safeSum(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new Error("Financial total exceeds supported range");
  return n;
}
export function method(value: string): string | null {
  const found = new Set<string>();
  const tests: [string, RegExp][] = [
    ["screenprint", /\b(PRINT|SCREEN(?:\s*PRINT(?:ING)?)?|SP)\b/i],
    ["heat-transfer", /\b(HEAT|DTF|TRANSFER|HTV)\b/i],
    ["embroidery", /\b(EMB|EMBROIDERY|EMBROIDERED|EMBROIDERING)\b/i],
    ["dtg", /\bDTG\b/i],
    ["engraving", /\b(ENGRAVED|ENGRAVING)\b/i],
  ];
  for (const [name, re] of tests) if (re.test(value)) found.add(name);
  return found.size === 1 ? [...found][0] : null;
}
export function parseDataCsv(text: string): ParsedData {
  if (Buffer.byteLength(text) > MAX_DATA_BYTES) throw new Error("File exceeds 5 MB");
  return parseDataRows(parseCsvRows(text.replace(/^\uFEFF/, "")), createHash("sha256").update(text).digest("hex"));
}
export function orderCalendarDate(value: string): string {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);
  const iso = match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) throw new Error("Invalid Order Date");
  return iso;
}
export function parseDataRows(rows: string[][], sourceHash: string): ParsedData {
  const headers = rows[0]?.map(cleanCell) ?? [];
  if (headers.length > 200 || new Set(headers).size !== headers.length) throw new Error("Duplicate or excessive headers");
  const required = ["Sales Order", "Name", "Order Number", "Order Date", "Process Name", "Style", "Color Name", "Size Name", "Item Qty", "Item Total", ...unitFields, ...orderFields];
  for (const h of required) if (!headers.includes(h)) throw new Error(`Missing Data Export column: ${h}`);
  if (rows.length < 2 || rows.length > MAX_DATA_ROWS + 1) throw new Error("Import requires 1–10000 lines");
  const orders = new Map<string, Record<string, number>>();
  const lines: DataLine[] = [];
  let salesOrder = "", storeName = "";
  const summary: DataSummary = { lineCount: 0, orderCount: 0, quantity: 0, itemTotalCents: 0, orderTotalCents: 0, orderComponentsCents: {}, unitComponentsExtendedCents: {} };
  for (const [i, row] of rows.slice(1).entries()) {
    if (row.length !== headers.length) throw new Error(`Row ${i + 2}: column count differs`);
    const get = (h: string) => cleanCell(row[headers.indexOf(h)] ?? "");
    const event = get("Sales Order");
    if (!/^\d{5,7}$/.test(event)) throw new Error(`Row ${i + 2}: invalid Sales Order`);
    if (salesOrder && salesOrder !== event) throw new Error("Import one Sales Order per snapshot");
    salesOrder = event;
    if (storeName && storeName !== get("Name")) throw new Error("Store name differs across rows");
    storeName = get("Name");
    if (!storeName || storeName.length > 300) throw new Error("Invalid store name");
    const orderNumber = get("Order Number");
    if (!/^\d{1,30}$/.test(orderNumber)) throw new Error(`Row ${i + 2}: invalid Order Number`);
    const quantity = Number(get("Item Qty"));
    if (!/^\d+$/.test(get("Item Qty")) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw new Error(`Row ${i + 2}: invalid quantity`);
    const unitCents = Object.fromEntries(unitFields.map(h => [h, cents(get(h))]));
    const componentsCents = Object.fromEntries(orderFields.map(h => [h, cents(get(h))]));
    const previous = orders.get(orderNumber);
    if (previous && orderFields.some(h => previous[h] !== componentsCents[h])) throw new Error(`Order ${orderNumber}: repeated order money differs; cannot safely deduplicate`);
    orders.set(orderNumber, componentsCents);
    const itemTotalCents = cents(get("Item Total"));
    if (unitCents["Item Price"] * quantity !== itemTotalCents) throw new Error(`Row ${i + 2}: Item Price × quantity differs from Item Total`);
    const processName = get("Process Name");
    lines.push({ rowOrdinal: i + 1, orderNumber, orderDate: orderCalendarDate(get("Order Date")), processName, plannedMethod: method(processName.split(":")[0]), style: get("Style"), color: get("Color Name"), size: get("Size Name"), productName: get("Product Name"), vendor: get("Vendor"), quantity, itemTotalCents, unitCents });
    summary.quantity = safeSum(summary.quantity, quantity);
    summary.itemTotalCents = safeSum(summary.itemTotalCents, itemTotalCents);
    for (const h of unitFields) summary.unitComponentsExtendedCents[h] = safeSum(summary.unitComponentsExtendedCents[h] ?? 0, unitCents[h] * quantity);
  }
  for (const values of orders.values()) for (const h of orderFields) summary.orderComponentsCents[h] = safeSum(summary.orderComponentsCents[h] ?? 0, values[h]);
  summary.lineCount = lines.length;
  summary.orderCount = orders.size;
  summary.orderTotalCents = summary.orderComponentsCents["Order Total"];
  return { salesOrder, storeName, sourceHash, summary, lines, orders: [...orders].map(([orderNumber, componentsCents]) => ({ orderNumber, componentsCents })), safeHeaders: required };
}