import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { parseReportFilters, filtersEcho } from "../lib/reports/filters";
import { loadReportOrders, type ReportOrder } from "../lib/reports/dataset";
import {
  computeStats,
  statusBreakdown,
  lineItemBreakdown,
  pricingMatrixBreakdown,
  imprintsByTier,
  orderQuantityBreakdown,
  type BreakdownRow,
} from "../lib/reports/breakdowns";

/**
 * Reports module. Reads Postgres ONLY (never the Printavo API) —
 * module-isolation requirement. Formulas replicate the legacy Insights
 * app (see .agents/memory/printavo-reporting-formulas.md).
 */

const router: IRouter = Router();

async function withOrders(
  req: Request,
  res: Response,
  build: (orders: ReportOrder[]) => Record<string, unknown>,
): Promise<void> {
  const { filters, errors } = parseReportFilters(
    req.query as Record<string, unknown>,
  );
  if (errors.length > 0) {
    res.status(400).json({ errors });
    return;
  }
  const orders = await loadReportOrders(filters);
  res.json({ filters: filtersEcho(filters), ...build(orders) });
}

function handler(
  build: (orders: ReportOrder[]) => Record<string, unknown>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    withOrders(req, res, build).catch((err) => {
      req.log.error({ err }, "Report failed");
      res.status(500).json({ error: "Report failed" });
    });
  };
}

router.get("/reports/orders", (req, res) => {
  (async () => {
    const { filters, errors } = parseReportFilters(
      req.query as Record<string, unknown>,
    );
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }
    const limitRaw = Number(req.query.limit ?? 100);
    const offsetRaw = Number(req.query.offset ?? 0);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500)
      : 100;
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    const orders = await loadReportOrders(filters);
    const page = orders.slice(offset, offset + limit).map((o) => ({
      id: o.id,
      visualId: o.visualId,
      orderType: o.orderType,
      statusName: o.statusName,
      nickname: o.nickname,
      customerName: o.customerName,
      total: o.total,
      qty: o.qty,
      createdAt: o.createdAt,
      invoiceAt: o.invoiceAt,
      productionDueAt: o.productionDueAt,
      dueAt: o.dueAt,
    }));
    res.json({
      filters: filtersEcho(filters),
      stats: computeStats(orders),
      total: orders.length,
      limit,
      offset,
      orders: page,
    });
  })().catch((err) => {
    req.log.error({ err }, "Orders report failed");
    res.status(500).json({ error: "Report failed" });
  });
});

router.get(
  "/reports/status-breakdown",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: statusBreakdown(orders),
  })),
);

router.get(
  "/reports/pricing-matrix-breakdown",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: pricingMatrixBreakdown(orders),
  })),
);

router.get(
  "/reports/imprints-by-tier",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: imprintsByTier(orders),
  })),
);

router.get(
  "/reports/order-quantity-breakdown",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: orderQuantityBreakdown(orders),
  })),
);

router.get(
  "/reports/style-number-breakdown",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: lineItemBreakdown(orders, (li) => li.itemNumber, "No Style"),
  })),
);

router.get(
  "/reports/brand-breakdown",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: lineItemBreakdown(orders, (li) => li.brand, "No Brand"),
  })),
);

router.get(
  "/reports/color-breakdown",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: lineItemBreakdown(orders, (li) => li.color, "No Color"),
  })),
);

/*
 * ── Payments (cash-basis) ────────────────────────────────────────────
 * Buckets by transaction_date: daily when the range spans ≤31 days,
 * else ISO-Monday weekly (matches Insights).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_TYPES = ["Payment", "PaymentDispute", "Refund", "Return", "Void"];

function parsePaymentParams(req: Request): {
  start: string;
  end: string;
  types: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const startRaw = typeof req.query.start === "string" ? req.query.start : "";
  const endRaw = typeof req.query.end === "string" ? req.query.end : "";
  let end = today;
  if (endRaw) {
    if (DATE_RE.test(endRaw)) end = endRaw;
    else errors.push("end must be YYYY-MM-DD");
  }
  let start = new Date(new Date(`${end}T00:00:00Z`).getTime() - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  if (startRaw) {
    if (DATE_RE.test(startRaw)) start = startRaw;
    else errors.push("start must be YYYY-MM-DD");
  }
  let types = PAYMENT_TYPES;
  const typesRaw = typeof req.query.types === "string" ? req.query.types : "";
  if (typesRaw.trim()) {
    types = typesRaw
      .split("||")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const bad = types.filter((t) => !PAYMENT_TYPES.includes(t));
    if (bad.length > 0) {
      errors.push(`types: unknown value(s) ${bad.join(", ")}`);
    }
  }
  return { start, end, types, errors };
}

function spanDays(start: string, end: string): number {
  return Math.round(
    (new Date(`${end}T00:00:00Z`).getTime() -
      new Date(`${start}T00:00:00Z`).getTime()) /
      86400000,
  );
}

router.get("/reports/payments", (req, res) => {
  (async () => {
    const { start, end, types, errors } = parsePaymentParams(req);
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }
    const daily = spanDays(start, end) <= 31;
    const bucketExpr = daily
      ? sql`transaction_date`
      : sql`date_trunc('week', transaction_date)::date`;
    const result = await db.execute(sql`
      SELECT ${bucketExpr} AS bucket,
             count(*)::int AS count,
             coalesce(sum(amount), 0)::float8 AS amount
      FROM pv_payments
      WHERE transaction_date >= ${start}::date
        AND transaction_date <= ${end}::date
        AND typename = ANY(${sql.param(types)})
      GROUP BY 1 ORDER BY 1
    `);
    const rows = result.rows as unknown as Array<{
      bucket: string | Date;
      count: number;
      amount: number;
    }>;
    const buckets = rows.map((r) => ({
      bucket:
        r.bucket instanceof Date
          ? r.bucket.toISOString().slice(0, 10)
          : String(r.bucket).slice(0, 10),
      count: r.count,
      amount: Math.round(r.amount * 100) / 100,
    }));
    res.json({
      start,
      end,
      types,
      granularity: daily ? "daily" : "weekly",
      total: Math.round(buckets.reduce((s, b) => s + b.amount, 0) * 100) / 100,
      count: buckets.reduce((s, b) => s + b.count, 0),
      buckets,
    });
  })().catch((err) => {
    req.log.error({ err }, "Payments report failed");
    res.status(500).json({ error: "Report failed" });
  });
});

router.get("/reports/payments/stats", (req, res) => {
  (async () => {
    const { start, end, errors } = parsePaymentParams(req);
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }
    const result = await db.execute(sql`
      SELECT typename,
             count(*)::int AS count,
             coalesce(sum(amount), 0)::float8 AS amount
      FROM pv_payments
      WHERE transaction_date >= ${start}::date
        AND transaction_date <= ${end}::date
      GROUP BY typename ORDER BY typename
    `);
    const rows = result.rows as unknown as Array<{
      typename: string;
      count: number;
      amount: number;
    }>;
    const byType = rows.map((r) => ({
      typename: r.typename,
      count: r.count,
      amount: Math.round(r.amount * 100) / 100,
    }));
    const net = Math.round(byType.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    res.json({ start, end, byType, net });
  })().catch((err) => {
    req.log.error({ err }, "Payments stats failed");
    res.status(500).json({ error: "Report failed" });
  });
});

router.get("/reports/filter-options", (req, res) => {
  (async () => {
    const [statuses, brands, categories, colors, styles, tiers] =
      await Promise.all([
        db.execute(
          sql`SELECT DISTINCT status_name AS v FROM pv_orders WHERE status_name IS NOT NULL ORDER BY 1`,
        ),
        db.execute(
          sql`SELECT brand AS v FROM pv_line_items WHERE brand IS NOT NULL AND brand <> '' GROUP BY 1 ORDER BY count(*) DESC LIMIT 500`,
        ),
        db.execute(
          sql`SELECT DISTINCT category_name AS v FROM pv_line_items WHERE category_name IS NOT NULL AND category_name <> '' ORDER BY 1`,
        ),
        db.execute(
          sql`SELECT color AS v FROM pv_line_items WHERE color IS NOT NULL AND color <> '' GROUP BY 1 ORDER BY count(*) DESC LIMIT 500`,
        ),
        db.execute(
          sql`SELECT item_number AS v FROM pv_line_items WHERE item_number IS NOT NULL AND item_number <> '' GROUP BY 1 ORDER BY count(*) DESC LIMIT 500`,
        ),
        db.execute(
          sql`SELECT DISTINCT column_name AS v FROM pv_imprints WHERE column_name IS NOT NULL AND column_name <> '' ORDER BY 1`,
        ),
      ]);
    const vals = (r: { rows: unknown[] }): string[] =>
      (r.rows as Array<{ v: string }>).map((x) => x.v);
    res.json({
      statuses: vals(statuses),
      brands: vals(brands),
      categories: vals(categories),
      colors: vals(colors),
      styleNumbers: vals(styles),
      tiers: vals(tiers),
      paymentTypes: PAYMENT_TYPES,
    });
  })().catch((err) => {
    req.log.error({ err }, "Filter options failed");
    res.status(500).json({ error: "Report failed" });
  });
});

export default router;
export type { BreakdownRow };
