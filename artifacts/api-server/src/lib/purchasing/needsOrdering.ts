import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Purchasing module — Needs Ordering scan.
 * Reads Postgres ONLY (never the Printavo API) — module-isolation
 * requirement. Replaces the legacy PO Builder two-pass Printavo crawl
 * (~90s) with a direct query against synced pv_line_items.product_status.
 */

export interface NeedsOrderingLineItem {
  id: string;
  itemNumber: string | null;
  color: string | null;
  description: string | null;
  brand: string | null;
  categoryName: string | null;
  items: number;
  price: number | null;
  sizes: { size: string; count: number }[];
}

export interface NeedsOrderingOrder {
  orderId: string;
  visualId: number;
  orderType: string;
  nickname: string | null;
  customerCompany: string | null;
  contactName: string | null;
  statusName: string | null;
  invoiceAt: string | null;
  productionDueAt: string | null;
  customerDueAt: string | null;
  detailSyncedAt: string | null;
  lineItems: NeedsOrderingLineItem[];
}

export interface NeedsOrderingResult {
  orders: NeedsOrderingOrder[];
  totalOrders: number;
  totalLineItems: number;
  totalPieces: number;
}

interface Row {
  li_id: string;
  item_number: string | null;
  color: string | null;
  description: string | null;
  brand: string | null;
  category_name: string | null;
  items: number;
  price: string | null;
  sizes: unknown;
  order_id: string;
  visual_id: number;
  order_type: string;
  nickname: string | null;
  customer_company: string | null;
  contact_name: string | null;
  status_name: string | null;
  invoice_at: string | null;
  production_due_at: string | null;
  customer_due_at: string | null;
  detail_synced_at: string | null;
}

function normalizeSizes(raw: unknown): { size: string; count: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is { size?: unknown; count?: unknown } =>
        typeof s === "object" && s !== null,
    )
    .map((s) => ({
      size: String(s.size ?? "")
        .replace(/^size_/i, "")
        .toUpperCase(),
      count: Number(s.count ?? 0),
    }))
    .filter((s) => s.size.length > 0 && s.count > 0);
}

export async function loadNeedsOrdering(): Promise<NeedsOrderingResult> {
  const rows = (await db.execute(sql`
    SELECT
      li.printavo_id AS li_id,
      li.item_number,
      li.color,
      li.description,
      li.brand,
      li.category_name,
      li.items,
      li.price,
      li.sizes,
      o.printavo_id AS order_id,
      o.visual_id,
      o.order_type,
      o.nickname,
      o.customer_company,
      o.contact_name,
      o.status_name,
      o.invoice_at::text AS invoice_at,
      o.production_due_at::text AS production_due_at,
      o.customer_due_at::text AS customer_due_at,
      o.detail_synced_at::text AS detail_synced_at
    FROM pv_line_items li
    JOIN pv_orders o ON o.printavo_id = li.order_id
    WHERE li.product_status = 'need_ordering'
    ORDER BY o.visual_id DESC, li.printavo_id
  `)) as unknown as { rows: Row[] };

  const byOrder = new Map<string, NeedsOrderingOrder>();
  let totalLineItems = 0;
  let totalPieces = 0;

  for (const r of rows.rows) {
    let order = byOrder.get(r.order_id);
    if (!order) {
      order = {
        orderId: r.order_id,
        visualId: r.visual_id,
        orderType: r.order_type,
        nickname: r.nickname,
        customerCompany: r.customer_company,
        contactName: r.contact_name,
        statusName: r.status_name,
        invoiceAt: r.invoice_at,
        productionDueAt: r.production_due_at,
        customerDueAt: r.customer_due_at,
        detailSyncedAt: r.detail_synced_at,
        lineItems: [],
      };
      byOrder.set(r.order_id, order);
    }
    const qty = Number(r.items ?? 0);
    order.lineItems.push({
      id: r.li_id,
      itemNumber: r.item_number,
      color: r.color,
      description: r.description,
      brand: r.brand,
      categoryName: r.category_name,
      items: qty,
      price: r.price === null ? null : Number(r.price),
      sizes: normalizeSizes(r.sizes),
    });
    totalLineItems += 1;
    totalPieces += qty;
  }

  return {
    orders: Array.from(byOrder.values()),
    totalOrders: byOrder.size,
    totalLineItems,
    totalPieces,
  };
}
