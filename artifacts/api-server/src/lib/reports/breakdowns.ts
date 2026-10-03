import type { ReportGroup, ReportOrder } from "./dataset";
import {
  emptyActivityBreakdown,
  type ActivityBreakdown,
} from "./activity";

/**
 * Report formulas ported from the legacy Insights app (must match exactly):
 * - Order revenue = invoice total (incl. tax), summed over filtered orders.
 * - Order qty = sum of line-item `items`.
 * - Pricing-matrix attribution: per group, groupRevenue = Σ(price × items),
 *   groupQty = Σ(items); revenue/qty split EVENLY across the group's
 *   imprints; order counts deduped per order per label.
 * - Percentages = value / totalFilteredRevenue, rounded to 0.1%.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (value: number, total: number): number =>
  total > 0 ? Math.round((value / total) * 1000) / 10 : 0;

export interface ReportStats {
  orders: number;
  revenue: number;
  quantity: number;
  avgOrderValue: number;
  activity: ActivityStats;
}

export interface ActivityStats {
  affectedOrders: number;
  changes: number;
  byOrderType: {
    invoice: number;
    quote: number;
  };
  byCategory: ActivityBreakdown;
}

export function computeStats(orders: ReportOrder[]): ReportStats {
  const revenue = orders.reduce((s, o) => s + o.total, 0);
  const quantity = orders.reduce((s, o) => s + o.qty, 0);
  return {
    orders: orders.length,
    revenue: round2(revenue),
    quantity,
    avgOrderValue: orders.length > 0 ? round2(revenue / orders.length) : 0,
    activity: computeActivityStats(orders),
  };
}

/** Activity is already reduced per order by the dataset query. */
export function computeActivityStats(orders: ReportOrder[]): ActivityStats {
  const stats: ActivityStats = {
    affectedOrders: 0,
    changes: 0,
    byOrderType: { invoice: 0, quote: 0 },
    byCategory: emptyActivityBreakdown(),
  };
  for (const order of orders) {
    if (order.activityCount <= 0) continue;
    stats.affectedOrders += 1;
    stats.changes += order.activityCount;
    for (const category of Object.keys(stats.byCategory) as Array<
      keyof ActivityBreakdown
    >) {
      stats.byCategory[category] += order.activityBreakdown[category];
    }
    if (order.orderType === "invoice") stats.byOrderType.invoice += 1;
    if (order.orderType === "quote") stats.byOrderType.quote += 1;
  }
  return stats;
}

export interface BreakdownRow {
  label: string;
  orders: number;
  quantity: number;
  revenue: number;
  pctOfRevenue: number;
}

interface Acc {
  orders: Set<string>;
  quantity: number;
  revenue: number;
}

function finish(
  map: Map<string, Acc>,
  totalRevenue: number,
): BreakdownRow[] {
  return [...map.entries()]
    .map(([label, acc]) => ({
      label,
      orders: acc.orders.size,
      quantity: Math.round(acc.quantity * 10) / 10,
      revenue: round2(acc.revenue),
      pctOfRevenue: pct(acc.revenue, totalRevenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

function bump(
  map: Map<string, Acc>,
  label: string,
  orderId: string,
  quantity: number,
  revenue: number,
): void {
  const acc = map.get(label) ?? { orders: new Set(), quantity: 0, revenue: 0 };
  acc.orders.add(orderId);
  acc.quantity += quantity;
  acc.revenue += revenue;
  map.set(label, acc);
}

export function statusBreakdown(orders: ReportOrder[]): BreakdownRow[] {
  const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
  const map = new Map<string, Acc>();
  for (const o of orders) {
    bump(map, o.statusName ?? "No Status", o.id, o.qty, o.total);
  }
  return finish(map, totalRevenue);
}

/** Line-item level breakdown (style number / brand / color / category).
 *  Revenue here is line-item revenue (price × items), NOT order total. */
export function lineItemBreakdown(
  orders: ReportOrder[],
  field: (li: {
    itemNumber: string | null;
    brand: string | null;
    color: string | null;
    categoryName: string | null;
  }) => string | null,
  fallbackLabel: string,
): BreakdownRow[] {
  const map = new Map<string, Acc>();
  let totalRevenue = 0;
  for (const o of orders) {
    for (const g of o.groups) {
      for (const li of g.lineItems) {
        const revenue = li.price * li.items;
        totalRevenue += revenue;
        const label = field(li)?.trim() || fallbackLabel;
        bump(map, label, o.id, li.items, revenue);
      }
    }
  }
  return finish(map, totalRevenue);
}

function groupRevenue(g: ReportGroup): number {
  return g.lineItems.reduce((s, li) => s + li.price * li.items, 0);
}

function groupQty(g: ReportGroup): number {
  return g.lineItems.reduce((s, li) => s + li.items, 0);
}

/** Pricing-matrix breakdown: label = "Matrix: Column"; group revenue and
 *  qty split evenly across the group's imprints. */
export function pricingMatrixBreakdown(orders: ReportOrder[]): BreakdownRow[] {
  return imprintBreakdown(orders, (imp) => {
    if (imp.matrixName && imp.columnName) {
      return `${imp.matrixName}: ${imp.columnName}`;
    }
    return imp.typeOfWork?.trim() || "Uncategorized";
  });
}

/** Imprints-by-tier: label = matrix column name (the "tier"). */
export function imprintsByTier(orders: ReportOrder[]): BreakdownRow[] {
  return imprintBreakdown(
    orders,
    (imp) => imp.columnName?.trim() || "No Tier",
  );
}

function imprintBreakdown(
  orders: ReportOrder[],
  labelOf: (imp: {
    matrixName: string | null;
    columnName: string | null;
    typeOfWork: string | null;
  }) => string,
): BreakdownRow[] {
  const map = new Map<string, Acc>();
  let totalRevenue = 0;
  for (const o of orders) {
    for (const g of o.groups) {
      if (g.imprints.length === 0) continue;
      const rev = groupRevenue(g);
      const qty = groupQty(g);
      totalRevenue += rev;
      const revShare = rev / g.imprints.length;
      const qtyShare = qty / g.imprints.length;
      for (const imp of g.imprints) {
        bump(map, labelOf(imp), o.id, qtyShare, revShare);
      }
    }
  }
  return finish(map, totalRevenue);
}

const QTY_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1-5", min: 1, max: 5 },
  { label: "6-11", min: 6, max: 11 },
  { label: "12-23", min: 12, max: 23 },
  { label: "24-35", min: 24, max: 35 },
  { label: "36-47", min: 36, max: 47 },
  { label: "48-59", min: 48, max: 59 },
  { label: "60-71", min: 60, max: 71 },
  { label: "72-83", min: 72, max: 83 },
  { label: "84-95", min: 84, max: 95 },
  { label: "96-107", min: 96, max: 107 },
  { label: "108-119", min: 108, max: 119 },
  { label: "120-143", min: 120, max: 143 },
  { label: "144-167", min: 144, max: 167 },
  { label: "168-191", min: 168, max: 191 },
  { label: "192-215", min: 192, max: 215 },
  { label: "216-239", min: 216, max: 239 },
  { label: "240-263", min: 240, max: 263 },
  { label: "264-287", min: 264, max: 287 },
  { label: "288+", min: 288, max: Infinity },
];

export function orderQuantityBreakdown(orders: ReportOrder[]): BreakdownRow[] {
  const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
  const map = new Map<string, Acc>();
  for (const bucket of QTY_BUCKETS) {
    map.set(bucket.label, { orders: new Set(), quantity: 0, revenue: 0 });
  }
  for (const o of orders) {
    const bucket = QTY_BUCKETS.find(
      (b) => o.qty >= b.min && o.qty <= b.max,
    );
    if (!bucket) continue;
    bump(map, bucket.label, o.id, o.qty, o.total);
  }
  const rows: BreakdownRow[] = [];
  for (const bucket of QTY_BUCKETS) {
    const acc = map.get(bucket.label);
    if (!acc) continue;
    rows.push({
      label: bucket.label,
      orders: acc.orders.size,
      quantity: acc.quantity,
      revenue: round2(acc.revenue),
      pctOfRevenue: pct(acc.revenue, totalRevenue),
    });
  }
  return rows;
}
