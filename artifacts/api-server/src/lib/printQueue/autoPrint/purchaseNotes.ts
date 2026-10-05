import { pool } from "@workspace/db";
import type { PurchaseNote } from "./presentation";

/** Only submitted Hub snapshots with exact current invoice/line/style/color
 * identity. No guessed matches for external purchases or converted quotes. */
export async function loadPurchaseNotes(orderId: string): Promise<PurchaseNote[]> {
  const { rows } = await pool.query(`
    SELECT p.id, p.po_number, p.vendor_name, p.submitted_to_vendor_at,
      li->>'printavoLineItemId' AS line_id,
      COALESCE(NULLIF(li->>'warehouseName',''), NULLIF(li->>'warehouseCode','')) AS warehouse
    FROM po_files p CROSS JOIN LATERAL jsonb_array_elements(p.line_items) li
    JOIN pv_line_items l ON l.printavo_id = li->>'printavoLineItemId'
      AND l.order_id = $1
      AND lower(trim(COALESCE(l.item_number,''))) = lower(trim(COALESCE(li->>'styleNumber','')))
      AND lower(trim(COALESCE(l.color,''))) = lower(trim(COALESCE(li->>'color','')))
    WHERE p.submitted_to_vendor_at IS NOT NULL
      AND li->>'printavoOrderId' = $1
    ORDER BY p.submitted_to_vendor_at, p.id`, [orderId]);
  const seen = new Set<string>();
  return rows.flatMap(row => {
    const key = `${row.id}:${row.line_id}:${row.warehouse}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const date = new Date(row.submitted_to_vendor_at).toLocaleDateString("en-US", { timeZone: "America/New_York" });
    const vendor = ({sanmar: "SanMar", ss: "S&S"} as Record<string, string>)[row.vendor_name] ?? row.vendor_name;
    return [{ lineId: row.line_id, text: `PO ${row.po_number} submitted ${date} · ${vendor} · Warehouse (selected): ${row.warehouse ?? "unavailable"}` }];
  });
}