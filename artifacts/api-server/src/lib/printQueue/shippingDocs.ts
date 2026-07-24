import {
  db,
  pvOrdersTable,
  pvLineItemGroupsTable,
  pvLineItemsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { PRINTAVO_SIZE_ENUM } from "@workspace/printavo";

/**
 * Print Queue — shipping documents (PQ3b) shared data layer.
 *
 * Packing slips and box labels are rendered ENTIRELY from the local sync
 * (pv_orders + pv_line_item_groups + pv_line_items) — never a Printavo
 * fetch. Invoices only: quotes don't ship, so they are silently filtered
 * here (the UI badges them as skipped before calling).
 *
 * The ship-to address comes from pv_orders.data.shippingAddress, which the
 * sync only started pulling with PQ3b — orders synced before that backfill
 * render with a "No shipping address on file" fallback block.
 */

export const MAX_SHIPPING_DOC_ORDERS = 50;

export interface ShipToAddress {
  customerName: string | null;
  companyName: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  stateIso: string | null;
  zipCode: string | null;
  country: string | null;
}

export interface SizeCount {
  /** Raw enum key like "size_s" (used for column matching). */
  key: string;
  /** Display label like "S". */
  label: string;
  count: number;
}

export interface ShippingDocLineItem {
  categoryName: string | null;
  itemNumber: string | null;
  color: string | null;
  description: string | null;
  quantity: number;
  /** Human size breakdown entries like "S×2", enum-ordered. */
  sizeBreakdown: string[];
  /** Structured per-size counts, enum-ordered (drives the size-matrix columns). */
  sizeCounts: SizeCount[];
}

export interface ShippingDocGroup {
  groupId: string;
  position: number | null;
  lineItems: ShippingDocLineItem[];
}

export interface ShippingDocOrder {
  printavoId: string;
  visualId: number;
  nickname: string | null;
  contactName: string | null;
  contactEmail: string | null;
  customerCompany: string | null;
  createdAt: string | null;
  customerDueAt: string | null;
  visualPoNumber: string | null;
  deliveryMethod: string | null;
  shipTo: ShipToAddress | null;
  billTo: ShipToAddress | null;
  groups: ShippingDocGroup[];
  totalQuantity: number;
}

/** Enum declaration order = display order; unknown sizes sort last, stable. */
const SIZE_ORDER = new Map([...PRINTAVO_SIZE_ENUM].map((s, i) => [s, i]));

function sizeLabel(raw: string): string {
  return raw.replace(/^size_/, "").toUpperCase();
}

/** Parse the raw sizes jsonb into structured, enum-ordered per-size counts. */
export function parseSizeCounts(sizes: unknown): SizeCount[] {
  if (!Array.isArray(sizes)) return [];
  const rows = sizes
    .filter(
      (s): s is { size: string; count: number } =>
        s != null &&
        typeof s === "object" &&
        typeof (s as { size?: unknown }).size === "string" &&
        typeof (s as { count?: unknown }).count === "number" &&
        (s as { count: number }).count > 0,
    )
    .map((s, i) => ({ ...s, idx: i }));
  rows.sort((a, b) => {
    const ao = SIZE_ORDER.get(a.size) ?? Number.MAX_SAFE_INTEGER;
    const bo = SIZE_ORDER.get(b.size) ?? Number.MAX_SAFE_INTEGER;
    return ao !== bo ? ao - bo : a.idx - b.idx;
  });
  return rows.map((s) => ({
    key: s.size,
    label: sizeLabel(s.size),
    count: s.count,
  }));
}

export function formatSizeBreakdown(
  sizes: unknown,
): { entries: string[]; total: number } {
  const counts = parseSizeCounts(sizes);
  return {
    entries: counts.map((s) => `${s.label}\u00d7${s.count}`),
    total: counts.reduce((sum, s) => sum + s.count, 0),
  };
}

interface OrderDataBlob {
  shippingAddress?: Partial<ShipToAddress> | null;
  billingAddress?: Partial<ShipToAddress> | null;
  visualPoNumber?: unknown;
  deliveryMethod?: { name?: unknown } | null;
  contact?: { email?: unknown } | null;
  createdAt?: unknown;
}

function readAddress(
  a: Partial<ShipToAddress> | null | undefined,
  opts: { requireStreet: boolean },
): ShipToAddress | null {
  if (a == null || typeof a !== "object") return null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  const addr: ShipToAddress = {
    customerName: str(a.customerName),
    companyName: str(a.companyName),
    address1: str(a.address1),
    address2: str(a.address2),
    city: str(a.city),
    state: str(a.state),
    stateIso: str(a.stateIso),
    zipCode: str(a.zipCode),
    country: str(a.country),
  };
  // A ship-to with no street line is not usable; billing renders with
  // whatever partial lines exist (matches Printavo's slip).
  if (opts.requireStreet) return addr.address1 ? addr : null;
  return addr.address1 || addr.city || addr.customerName || addr.companyName
    ? addr
    : null;
}

/**
 * Load the selected orders (invoices only, caller's order preserved) with
 * grouped line items. Returns [] when nothing matches.
 */
export async function loadShippingDocOrders(
  orderIds: string[],
): Promise<ShippingDocOrder[]> {
  const orderRows = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      visualId: pvOrdersTable.visualId,
      orderType: pvOrdersTable.orderType,
      nickname: pvOrdersTable.nickname,
      contactName: pvOrdersTable.contactName,
      customerCompany: pvOrdersTable.customerCompany,
      customerDueAt: pvOrdersTable.customerDueAt,
      data: pvOrdersTable.data,
    })
    .from(pvOrdersTable)
    .where(inArray(pvOrdersTable.printavoId, orderIds));

  const invoices = orderRows.filter((r) => r.orderType === "invoice");
  if (invoices.length === 0) return [];
  const invoiceIds = invoices.map((r) => r.printavoId);

  const [groupRows, lineRows] = await Promise.all([
    db
      .select({
        printavoId: pvLineItemGroupsTable.printavoId,
        orderId: pvLineItemGroupsTable.orderId,
        position: pvLineItemGroupsTable.position,
      })
      .from(pvLineItemGroupsTable)
      .where(inArray(pvLineItemGroupsTable.orderId, invoiceIds)),
    db
      .select({
        groupId: pvLineItemsTable.groupId,
        orderId: pvLineItemsTable.orderId,
        categoryName: pvLineItemsTable.categoryName,
        itemNumber: pvLineItemsTable.itemNumber,
        color: pvLineItemsTable.color,
        description: pvLineItemsTable.description,
        items: pvLineItemsTable.items,
        sizes: pvLineItemsTable.sizes,
      })
      .from(pvLineItemsTable)
      .where(inArray(pvLineItemsTable.orderId, invoiceIds)),
  ]);

  const linesByGroup = new Map<string, ShippingDocLineItem[]>();
  for (const row of lineRows) {
    const sizeCounts = parseSizeCounts(row.sizes);
    const sizesTotal = sizeCounts.reduce((sum, s) => sum + s.count, 0);
    const quantity = row.items > 0 ? row.items : sizesTotal;
    // Zero-qty placeholder lines (no pieces, no size breakdown) are noise on
    // a shipping doc and invite warehouse miscounts — skip them.
    if (quantity === 0 && sizeCounts.length === 0) continue;
    const item: ShippingDocLineItem = {
      categoryName: row.categoryName,
      itemNumber: row.itemNumber,
      color: row.color,
      description: row.description,
      quantity,
      sizeBreakdown: sizeCounts.map((s) => `${s.label}\u00d7${s.count}`),
      sizeCounts,
    };
    const list = linesByGroup.get(row.groupId);
    if (list) list.push(item);
    else linesByGroup.set(row.groupId, [item]);
  }

  const groupsByOrder = new Map<string, ShippingDocGroup[]>();
  for (const g of groupRows) {
    const group: ShippingDocGroup = {
      groupId: g.printavoId,
      position: g.position,
      lineItems: linesByGroup.get(g.printavoId) ?? [],
    };
    const list = groupsByOrder.get(g.orderId);
    if (list) list.push(group);
    else groupsByOrder.set(g.orderId, [group]);
  }
  for (const groups of groupsByOrder.values()) {
    groups.sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) -
        (b.position ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const byId = new Map(invoices.map((r) => [r.printavoId, r]));
  // Preserve the caller's selection order, skipping unknown ids.
  return orderIds
    .filter((id) => byId.has(id))
    .map((id) => {
      const row = byId.get(id)!;
      const blob = (row.data ?? null) as OrderDataBlob | null;
      const groups = groupsByOrder.get(row.printavoId) ?? [];
      const totalQuantity = groups.reduce(
        (sum, g) => sum + g.lineItems.reduce((s, li) => s + li.quantity, 0),
        0,
      );
      const poRaw = blob?.visualPoNumber;
      const dmRaw = blob?.deliveryMethod?.name;
      const emailRaw = blob?.contact?.email;
      const createdRaw = blob?.createdAt;
      return {
        printavoId: row.printavoId,
        visualId: row.visualId,
        nickname: row.nickname,
        contactName: row.contactName,
        contactEmail:
          typeof emailRaw === "string" && emailRaw.trim().length > 0
            ? emailRaw.trim()
            : null,
        customerCompany: row.customerCompany,
        createdAt:
          typeof createdRaw === "string" && createdRaw.trim().length > 0
            ? createdRaw.trim()
            : null,
        customerDueAt: row.customerDueAt
          ? row.customerDueAt.toISOString()
          : null,
        visualPoNumber:
          typeof poRaw === "string" && poRaw.trim().length > 0
            ? poRaw.trim()
            : null,
        deliveryMethod:
          typeof dmRaw === "string" && dmRaw.trim().length > 0
            ? dmRaw.trim()
            : null,
        shipTo: readAddress(blob?.shippingAddress, { requireStreet: true }),
        billTo: readAddress(blob?.billingAddress, { requireStreet: false }),
        groups,
        totalQuantity,
      };
    });
}

/** Shared HTML-escape helper for the shipping-doc renderers. */
export function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Multi-line ship-to block lines (escaped), or null when no usable address. */
export function shipToLines(order: ShippingDocOrder): string[] | null {
  const a = order.shipTo;
  if (!a) return null;
  const cityLine = [
    a.city,
    a.stateIso ?? a.state,
    a.zipCode,
  ]
    .filter(Boolean)
    .join(", ")
    .replace(/, ([^,]*)$/, " $1");
  const lines = [
    a.customerName,
    a.companyName,
    a.address1,
    a.address2,
    cityLine || null,
    a.country && a.country !== "US" ? a.country : null,
  ].filter((l): l is string => Boolean(l && l.trim()));
  return lines.map((l) => esc(l));
}
