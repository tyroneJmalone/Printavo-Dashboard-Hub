/**
 * Parsers for Chipply portal CSV exports (CH2).
 *
 * Two known files, detected by header row:
 *   - SalesReport: one row per store + a trailing summary row with a BLANK
 *     "Store Name" that duplicates the totals (must be skipped).
 *   - Margin Report: per-style vendor/cost/profit rows. Carries NO store
 *     identifier — callers must supply store context (detail-page upload).
 *
 * Pure functions, no I/O — mirrors parseEmail.ts so it can be harness-tested.
 * All fields tolerant/nullable: a missing column never throws.
 *
 * Money arrives as 4-decimal strings ("1077.6500"); we normalize to
 * 2-decimal strings. Dates arrive as "M/D/YYYY h:mm AM/PM"; we keep the
 * calendar date as "YYYY-MM-DD" WITHOUT going through Date() (timezone rule).
 */

// ── CSV tokenizer (quoted fields, escaped quotes, CRLF) ───────────────

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const push = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    push();
    // Skip rows that are entirely empty (trailing newline artifacts).
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      push();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

// ── Field normalizers ──────────────────────────────────────────────────

/** "1077.6500" / "$2,200.00" / "" → "1077.65" | null. Signed (credits). */
export function moneyStr(raw: string | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim().replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

export function intOrNull(raw: string | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim().replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isInteger(n)) return null;
  return n;
}

/** "6/16/2026 12:41 PM" or "7/5/2026" → "2026-06-16" | null. No Date(). */
export function csvDateToIso(raw: string | undefined): string | null {
  if (raw == null) return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const mm = mo.padStart(2, "0");
  const dd = d.padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function cleanText(raw: string | undefined): string | null {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  return t || null;
}

// ── File detection ─────────────────────────────────────────────────────

export type ChipplyCsvKind = "sales_report" | "margin_report" | "unknown";

const SALES_MARKERS = ["store name", "sale order", "chipply fee"];
const MARGIN_MARKERS = ["vendor name", "style", "total profit"];

/** Detailed exports have their own reviewed importer, not margin-row semantics. */
export function isDetailedDataExport(headers: string[]): boolean {
  const set = new Set(headers.map((h) => h.trim().toLowerCase()));
  return ["sales order", "order number", "process name", "item qty", "item total"].every((h) => set.has(h));
}

export function detectCsvKind(headers: string[]): ChipplyCsvKind {
  const set = new Set(headers.map((h) => h.trim().toLowerCase()));
  if (SALES_MARKERS.every((m) => set.has(m))) return "sales_report";
  if (MARGIN_MARKERS.every((m) => set.has(m))) return "margin_report";
  return "unknown";
}

function headerIndex(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((h, i) => map.set(h.trim().toLowerCase(), i));
  return map;
}

// ── SalesReport ────────────────────────────────────────────────────────

export interface ParsedSalesReport {
  storeName: string | null;
  eventId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  salesperson: string | null;
  organizationName: string | null;
  orgFee: string | null;
  productCost: string | null;
  productPrice: string | null;
  processPrice: string | null;
  combinedPrice: string | null;
  optionFees: string | null;
  sizeUpcharges: string | null;
  fundraising: string | null;
  tax: string | null;
  shipping: string | null;
  handlingFee: string | null;
  manualAdjustment: string | null;
  orderTotal: string | null;
  paymentCard: string | null;
  paymentKlarna: string | null;
  paymentEcert: string | null;
  paymentPo: string | null;
  paymentPromo: string | null;
  chipplyFee: string | null;
  ccProcessingFee: string | null;
  /** Sell price = combined + size upcharges + fundraising (matches the
   * email's "Total Dollars"). Null unless all three parts are present. */
  totalDollarsGuess: string | null;
}

/**
 * Parse a SalesReport CSV. Returns the FIRST data row with a non-blank
 * Store Name (the export is one store per file; the second row is a
 * nameless summary duplicate) plus how many named rows were seen so the
 * caller can warn if a multi-store file ever shows up.
 */
export function parseSalesReportCsv(text: string): {
  parsed: ParsedSalesReport | null;
  namedRowCount: number;
} {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return { parsed: null, namedRowCount: 0 };
  const idx = headerIndex(rows[0]);
  const get = (row: string[], col: string): string | undefined => {
    const i = idx.get(col);
    return i == null ? undefined : row[i];
  };
  const dataRows = rows
    .slice(1)
    .filter((r) => (get(r, "store name") ?? "").trim() !== "");
  const r = dataRows[0];
  if (!r) return { parsed: null, namedRowCount: 0 };

  const eventIdRaw = (get(r, "sale order") ?? "").trim();
  const combined = moneyStr(get(r, "combined price"));
  const upcharges = moneyStr(get(r, "size upcharges"));
  const fundraising = moneyStr(get(r, "fundraising"));
  const totalDollarsGuess =
    combined != null && upcharges != null && fundraising != null
      ? (Number(combined) + Number(upcharges) + Number(fundraising)).toFixed(2)
      : null;

  return {
    namedRowCount: dataRows.length,
    parsed: {
      storeName: cleanText(get(r, "store name")),
      eventId: /^\d{5,7}$/.test(eventIdRaw) ? eventIdRaw : null,
      openedAt: csvDateToIso(get(r, "open date")),
      closedAt: csvDateToIso(get(r, "close date")),
      salesperson: cleanText(get(r, "salesperson")),
      organizationName: cleanText(get(r, "organization name")),
      orgFee: moneyStr(get(r, "organization fee")),
      productCost: moneyStr(get(r, "product cost")),
      productPrice: moneyStr(get(r, "product price")),
      processPrice: moneyStr(get(r, "process price")),
      combinedPrice: combined,
      optionFees: moneyStr(get(r, "option fees")),
      sizeUpcharges: upcharges,
      fundraising,
      tax: moneyStr(get(r, "tax")),
      shipping: moneyStr(get(r, "shipping")),
      handlingFee: moneyStr(get(r, "handling fee")),
      manualAdjustment: moneyStr(get(r, "manual adjustment")),
      orderTotal: moneyStr(get(r, "order total")),
      paymentCard: moneyStr(get(r, "payment card $")),
      paymentKlarna: moneyStr(get(r, "payment klarna $")),
      paymentEcert: moneyStr(get(r, "payment ecert $")),
      paymentPo: moneyStr(get(r, "payment po $")),
      paymentPromo: moneyStr(get(r, "payment promo $")),
      chipplyFee: moneyStr(get(r, "chipply fee")),
      ccProcessingFee: moneyStr(get(r, "credit card processing fee")),
      totalDollarsGuess,
    },
  };
}

// ── Margin Report ──────────────────────────────────────────────────────

export interface ParsedMarginRow {
  vendorName: string | null;
  style: string | null;
  productName: string | null;
  purchases: number | null;
  totalSale: string | null;
  totalCost: string | null;
  totalProfit: string | null;
}

export function parseMarginReportCsv(text: string): ParsedMarginRow[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const idx = headerIndex(rows[0]);
  const get = (row: string[], col: string): string | undefined => {
    const i = idx.get(col);
    return i == null ? undefined : row[i];
  };
  return rows
    .slice(1)
    .map((r) => ({
      vendorName: cleanText(get(r, "vendor name")),
      style: cleanText(get(r, "style")),
      productName: cleanText(get(r, "product name")),
      purchases: intOrNull(get(r, "number of purchases")),
      totalSale: moneyStr(get(r, "total sale")),
      totalCost: moneyStr(get(r, "total cost")),
      totalProfit: moneyStr(get(r, "total profit")),
    }))
    .filter(
      (row) =>
        row.vendorName != null || row.style != null || row.productName != null,
    );
}
