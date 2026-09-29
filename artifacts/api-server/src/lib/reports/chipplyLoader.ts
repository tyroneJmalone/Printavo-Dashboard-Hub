import { pool } from "@workspace/db";
import { getChipplyDataDetail } from "../chipply/dataService";
import { filterChipplyLines, summarizeChipplyLines, type ChipplyReportFilters, type ChipplyReportLine } from "./chipplyData";

/** No invoice dollars are read; mirror metadata is fetched separately, never a multiplying join. */
export async function loadChipplyReport(filters: ChipplyReportFilters) {
  const stores = await pool.query<{
    id: string; store_name: string; event_id: string | null; customer: string | null; closed_at: string | null;
  }>(`SELECT id,store_name,event_id,COALESCE(organization_name,org_contact) AS customer,closed_at::text
      FROM chipply_stores ORDER BY store_name,id`);
  const metadata = await pool.query<{ id: string; status: string | null; nickname: string | null; customer: string | null }>(
    `SELECT printavo_id AS id,status_name AS status,nickname,COALESCE(customer_company,contact_name) AS customer
     FROM pv_orders WHERE nickname ~ '^\\d{5,7}\\s' AND order_type='invoice'`);
  const invoices = new Map(metadata.rows.map(r => [r.id, r]));
  const lines: ChipplyReportLine[] = [];
  const coverage: { storeId: string; storeName: string; eventId: string | null; hasDetailedFinancials: boolean }[] = [];
  // Bounded batches avoid flooding the connection pool with per-store reconciliation reads.
  for (let offset = 0; offset < stores.rows.length; offset += 5) {
    await Promise.all(stores.rows.slice(offset, offset + 5).map(async store => {
      const detail = await getChipplyDataDetail(store.id);
      coverage.push({ storeId: store.id, storeName: store.store_name, eventId: store.event_id, hasDetailedFinancials: !!detail });
      if (!detail) return;
      for (const line of detail.lines) {
        const rec = line.reconciliation;
        const allocated = ["matched", "reviewed"].includes(rec.outcome) && !!rec.invoiceId;
        const invoice = allocated ? invoices.get(rec.invoiceId!) : undefined;
        const actualMethod = allocated ? rec.actualMethod : null;
        lines.push({
          storeId: store.id, storeName: store.store_name, eventId: store.event_id,
          customer: invoice?.customer ?? store.customer, closedAt: store.closed_at,
          transactionDate: line.orderDate, rowOrdinal: line.rowOrdinal, orderNumber: line.orderNumber,
          processName: line.processName, plannedMethod: line.plannedMethod, actualMethod,
          methodChanged: actualMethod && line.plannedMethod ? actualMethod !== line.plannedMethod : null,
          outcome: rec.outcome, reason: rec.reason, invoiceId: allocated ? rec.invoiceId : null,
          status: invoice?.status ?? null, nickname: invoice?.nickname ?? null,
          vendor: line.vendor, product: line.productName, style: line.style, color: line.color,
          size: line.size, quantity: line.quantity, itemTotalCents: line.itemTotalCents,
        });
      }
    }));
  }
  lines.sort((a, b) => a.storeId.localeCompare(b.storeId) || a.rowOrdinal - b.rowOrdinal);
  const filtered = filterChipplyLines(lines, filters);
  return {
    source: "chipply" as const, filters, summary: summarizeChipplyLines(filtered), lines: filtered,
    coverage: {
      scope: "All Chipply stores, before line/date filters",
      totalStores: coverage.length,
      storesWithDetailedFinancials: coverage.filter(s => s.hasDetailedFinancials).length,
      missingStores: coverage.filter(s => !s.hasDetailedFinancials),
      linesMissingTransactionDate: lines.filter(l => !l.transactionDate).length,
      linesMissingClosedDate: lines.filter(l => !l.closedAt).length,
    },
    warnings: [
      "Chipply item revenue only; never combined with Printavo revenue.",
      "Order fees, shipping, tax and order totals are omitted: these cannot be allocated to filtered product rows.",
      "Actual method and Printavo metadata are shown only for matched or reviewed lines. All others are Unallocated.",
      "Stores without detailed imports are missing coverage, not zero revenue.",
      "Dates use the exported order calendar date or store closed date; missing dates are excluded when a date range is set.",
    ],
  };
}