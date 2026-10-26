import type { ReportOrder } from "./dataset";

const rangeKeys = ["minCustomerTotal", "maxCustomerTotal", "minCustomerQty",
  "maxCustomerQty", "minCustomerOrders", "maxCustomerOrders"] as const;
type RangeKey = typeof rangeKeys[number];
export type CustomerRanges = Partial<Record<RangeKey, number>>;

export function parseCustomerRanges(query: Record<string, unknown>) {
  const ranges: CustomerRanges = {};
  const errors: string[] = [];
  for (const key of rangeKeys) {
    const raw = query[key];
    if (raw === undefined || raw === "") continue;
    const value = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < 0 || (key.endsWith("Orders") && !Number.isSafeInteger(value))) {
      errors.push(`${key} must be a non-negative ${key.endsWith("Orders") ? "integer" : "number"}`);
    } else ranges[key] = value;
  }
  for (const suffix of ["Total", "Qty", "Orders"] as const) {
    const min = ranges[`minCustomer${suffix}`], max = ranges[`maxCustomer${suffix}`];
    if (min !== undefined && max !== undefined && min > max) errors.push(`Minimum customer ${suffix.toLowerCase()} cannot exceed maximum`);
  }
  return { ranges, errors };
}

interface CustomerRow {
  key: string;
  customerId: string | null;
  customerName: string;
  orders: number;
  invoices: number;
  quotes: number;
  revenue: number;
  quantity: number;
  avgOrderValue: number;
  categories: string[];
  firstInvoiceDate: string | null;
  lastInvoiceDate: string | null;
}
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Whole-order totals, after shared order filters. Never merge unrelated
 * customers by display name, or treat missing IDs as one customer. */
export function buildCustomerReport(orders: ReportOrder[], ranges: CustomerRanges = {}) {
  const groups = new Map<string, CustomerRow>();
  const seen = new Set<string>();
  for (const order of orders) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    const customerId = order.customerId || null;
    const key = customerId ? `customer:${customerId}` : `unlinked-order:${order.id}`;
    let row = groups.get(key);
    if (!row) {
      row = { key, customerId, customerName: order.customerName || "Unknown customer",
        orders: 0, invoices: 0, quotes: 0, revenue: 0, quantity: 0, avgOrderValue: 0,
        categories: [], firstInvoiceDate: null, lastInvoiceDate: null };
      groups.set(key, row);
    }
    row.orders++;
    if (order.orderType === "invoice") row.invoices++;
    if (order.orderType === "quote") row.quotes++;
    row.revenue += order.total;
    row.quantity += order.qty;
    for (const group of order.groups) for (const item of group.lineItems) {
      const category = item.categoryName?.trim();
      if (category && !row.categories.includes(category)) row.categories.push(category);
    }
    const date = order.invoiceAt?.slice(0, 10);
    if (date) {
      if (!row.firstInvoiceDate || date < row.firstInvoiceDate) row.firstInvoiceDate = date;
      if (!row.lastInvoiceDate || date > row.lastInvoiceDate) row.lastInvoiceDate = date;
    }
  }
  const customers = [...groups.values()].map(row => ({
    ...row, revenue: round(row.revenue), quantity: round(row.quantity),
    avgOrderValue: round(row.revenue / row.orders),
    categories: row.categories.sort((a, b) => a.localeCompare(b)),
  })).filter(row =>
    (ranges.minCustomerTotal === undefined || row.revenue >= ranges.minCustomerTotal) &&
    (ranges.maxCustomerTotal === undefined || row.revenue <= ranges.maxCustomerTotal) &&
    (ranges.minCustomerQty === undefined || row.quantity >= ranges.minCustomerQty) &&
    (ranges.maxCustomerQty === undefined || row.quantity <= ranges.maxCustomerQty) &&
    (ranges.minCustomerOrders === undefined || row.orders >= ranges.minCustomerOrders) &&
    (ranges.maxCustomerOrders === undefined || row.orders <= ranges.maxCustomerOrders)
  ).sort((a, b) => b.revenue - a.revenue || a.customerName.localeCompare(b.customerName) || a.key.localeCompare(b.key));
  return {
    customers,
    customerCount: customers.filter(row => row.customerId !== null).length,
    unlinkedOrders: customers.filter(row => row.customerId === null).reduce((sum, row) => sum + row.orders, 0),
    orders: customers.reduce((sum, row) => sum + row.orders, 0),
    revenue: round(customers.reduce((sum, row) => sum + row.revenue, 0)),
    quantity: round(customers.reduce((sum, row) => sum + row.quantity, 0)),
  };
}
