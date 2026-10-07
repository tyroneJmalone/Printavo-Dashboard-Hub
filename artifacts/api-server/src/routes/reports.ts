import { Router, type IRouter, type Request, type Response } from "express";
import { decorationProduction } from "../lib/reports/decorationProduction";
import { loadProductionWorkload } from "../lib/reports/productionWorkloadLoader";
import { validDate, observedDay, merchMatches, type Method, type MerchScope } from "../lib/reports/productionWorkload";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { parseReportFilters, filtersEcho } from "../lib/reports/filters";
import { loadReportOrders, type ReportOrder } from "../lib/reports/dataset";
import { feeRows } from "../lib/reports/fees";
import { parseChipplyReportFilters, chipplyReportCsv } from "../lib/reports/chipplyData";
import { loadChipplyReport } from "../lib/reports/chipplyLoader";
import {
  computeStats,
  statusBreakdown,
  lineItemBreakdown,
  pricingMatrixBreakdown,
  imprintsByTier,
  orderQuantityBreakdown,
  type BreakdownRow,
} from "../lib/reports/breakdowns";
import {
  activityFieldLabel,
  currentOwnerMatches,
  paginateReportRows,
  serializeReportOrder,
  type ActivityCategory,
  type ActivityEventType,
} from "../lib/reports/activity";
import {
  activityCategorySql,
  qualifyingActivitySql,
} from "../lib/reports/activitySql";

/**
 * Reports module. Reads Postgres ONLY (never the Printavo API) —
 * module-isolation requirement. Formulas replicate the legacy Insights
 * app (see .agents/memory/printavo-reporting-formulas.md).
 */

const router: IRouter = Router();

router.get("/reports/fees", (req, res) => {
  (async () => {
    const { filters, errors } = parseReportFilters(req.query as Record<string, unknown>);
    if (errors.length) { res.status(400).json({ errors }); return; }
    const orders = (await loadReportOrders(filters)).filter(o => o.orderType === "invoice");
    const sources = orders.length ? await db.execute(sql`
      SELECT printavo_id, extras, extras_synced_at, extras_stale FROM pv_orders
      WHERE printavo_id IN (${sql.join(orders.map(o => sql`${o.id}`), sql`, `)})
    `) : { rows: [] };
    res.json(feeRows(orders, sources.rows));
  })().catch(err => { req.log.error({ err }, "Fee report failed"); res.status(500).json({ error: "Unable to load fee report" }); });
});

router.get("/reports/chipply", (req, res) => {
  (async () => {
    let filters;
    try {
      filters = parseChipplyReportFilters(req.query as Record<string, unknown>);
      if (req.query.format !== undefined && !["json", "csv"].includes(String(req.query.format))) throw new Error("Invalid format");
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid filters" });
      return;
    }
    const report = await loadChipplyReport(filters);
    if (req.query.format === "csv") {
      res.type("text/csv").attachment("chipply-report.csv").send(chipplyReportCsv(report.lines));
    } else {
      res.json(report);
    }
  })().catch(err => {
    req.log.error({ err }, "Chipply report failed");
    res.status(500).json({ error: "Chipply report could not be loaded. No revenue totals are available." });
  });
});

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

router.get("/reports/production-workload", (req, res) => {
  (async () => {
    const { start, end } = req.query;
    const method = req.query.method ?? "print", merch = req.query.merch ?? "all";
    const baselineWeeks = Number(req.query.baselineWeeks ?? 8);
    if (!validDate(start) || !validDate(end) || start > end
      || start < observedDay(new Date().toISOString())
      || (Date.parse(end) - Date.parse(start)) / 86400000 > 91
      || !["print", "embroidery"].includes(String(method)) || !["all", "only", "exclude"].includes(String(merch))
      || ![4, 8, 12].includes(baselineWeeks) || Array.isArray(req.query.baselineWeeks)
      || typeof method !== "string" || typeof merch !== "string") {
      res.status(400).json({ error: "Choose a future range beginning today or later, at most 92 days, a valid method/Merch scope, and 4, 8, or 12 baseline weeks." }); return;
    }
    res.json(await loadProductionWorkload({ start, end, method: method as Method, merch: merch as MerchScope, baselineWeeks }));
  })().catch(err => { req.log.error({ err }, "Production workload failed"); res.status(500).json({ error: "Unable to load production workload" }); });
});

router.get("/reports/decoration-production", (req, res) => {
  (async () => {
    const { filters, errors } = parseReportFilters(req.query as Record<string, unknown>);
    const method = String(req.query.method ?? "print");
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 20);
    const locationCount = req.query.locationCount === undefined ? undefined : Number(req.query.locationCount);
    if (!["print", "embroidery"].includes(method)) errors.push("Invalid decoration method");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      errors.push("Invalid pagination");
    if (locationCount !== undefined && (!Number.isSafeInteger(locationCount) || locationCount < 1))
      errors.push("Invalid location count");
    if (errors.length) { res.status(400).json({ errors }); return; }
    const merch = req.query.merch ?? "all";
    if (typeof merch !== "string" || !["all", "only", "exclude"].includes(merch)) { res.status(400).json({ error: "Invalid Merch scope" }); return; }
    const orders = (await loadReportOrders(filters, { includeMerch: true })).filter(o => merchMatches(o.productionMerch, merch as MerchScope));
    if (req.query.unknownOnly !== undefined && !["true", "false"].includes(String(req.query.unknownOnly))) {
      res.status(400).json({ error: "unknownOnly must be true or false" });
      return;
    }
    res.json(decorationProduction(orders, method as "print" | "embroidery", { offset, limit, locationCount, unknownOnly: req.query.unknownOnly === "true" }));
  })().catch(err => { req.log.error({ err }, "Decoration production report failed"); res.status(500).json({ error: "Unable to load decoration production report" }); });
});

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
    const page = paginateReportRows(orders, offset, limit).map(serializeReportOrder);
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

/**
 * Bounded, local-only activity detail for one order. This deliberately uses
 * the same qualifying predicate/category SQL as the report aggregate and
 * applies the report's inclusive Eastern date and current-owner filters.
 */
router.get("/reports/orders/:orderId/activity", (req, res) => {
  (async () => {
    const { filters, errors } = parseReportFilters(
      req.query as Record<string, unknown>,
    );
    const requestedLimit = Number(req.query.limit ?? 25);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
      : 25;
    const beforeRaw = req.query.beforeId;
    const beforeId =
      typeof beforeRaw === "string" && beforeRaw.trim() !== ""
        ? Number(beforeRaw)
        : null;
    if (
      beforeRaw !== undefined &&
      (!Number.isInteger(beforeId) || (beforeId ?? 0) <= 0)
    ) {
      errors.push("beforeId must be a positive integer");
    }
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }

    const orderId = req.params.orderId;
    const orderResult = await db.execute(sql`
      SELECT
        printavo_id AS id,
        visual_id AS visual_id,
        order_type AS order_type,
        owner_email AS owner_email,
        invoice_at AS invoice_at
      FROM pv_orders
      WHERE printavo_id = ${orderId}
      LIMIT 1
    `);
    const order = (orderResult.rows[0] ?? null) as {
      id: string;
      visual_id: number | null;
      order_type: string;
      owner_email: string | null;
      invoice_at: string | null;
    } | null;
    if (!order) {
      res.status(404).json({ error: "Order was not found in the local mirror" });
      return;
    }
    if (!currentOwnerMatches(order.owner_email, filters.activityOwner)) {
      res.status(404).json({ error: "Order is outside the selected owner filter" });
      return;
    }

    const dateConditions: SQL[] = [];
    if (filters.activityStart) {
      dateConditions.push(
        sql`(ce.occurred_at AT TIME ZONE 'America/New_York')::date >= ${filters.activityStart}::date`,
      );
    }
    if (filters.activityEnd) {
      dateConditions.push(
        sql`(ce.occurred_at AT TIME ZONE 'America/New_York')::date <= ${filters.activityEnd}::date`,
      );
    }
    const dateWhere = dateConditions.length
      ? sql` AND ${sql.join(dateConditions, sql` AND `)}`
      : sql``;
    const cursorWhere = beforeId
      ? sql` WHERE id < ${beforeId}`
      : sql``;
    const eventRows = await db.execute(sql`
      WITH activity_events AS (
        SELECT
          ce.id,
          ce.entity_type,
          ce.entity_id,
          ce.event_type,
          ce.field,
          ce.old_value,
          ce.new_value,
          ce.occurred_at,
          ${activityCategorySql(
            sql`ce.entity_type`,
            sql`ce.event_type`,
            sql`ce.field`,
          )} AS category
        FROM change_events ce
        WHERE ${qualifyingActivitySql(
          sql`ce.entity_type`,
          sql`ce.event_type`,
          sql`ce.entity_id`,
          sql`ce.order_id`,
        )}
          AND (
            (ce.entity_type = 'order' AND ce.entity_id = ${orderId})
            OR (ce.entity_type = 'line_item' AND ce.order_id = ${orderId})
          )${dateWhere}
      ),
      activity_totals AS (
        SELECT
          count(*)::int AS total_changes,
          count(*) FILTER (WHERE category = 'quantity')::int AS quantity_changes,
          count(*) FILTER (WHERE category = 'lineItem')::int AS line_item_changes,
          count(*) FILTER (WHERE category = 'price')::int AS price_changes,
          count(*) FILTER (WHERE category = 'balance')::int AS balance_changes,
          count(*) FILTER (WHERE category = 'status')::int AS status_changes,
          count(*) FILTER (WHERE category = 'order')::int AS order_changes
        FROM activity_events
      ),
      paged AS (
        SELECT *
        FROM activity_events${cursorWhere}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${limit + 1}
      )
      SELECT paged.*, activity_totals.*
      FROM activity_totals
      LEFT JOIN paged ON true
      ORDER BY paged.occurred_at DESC NULLS LAST, paged.id DESC NULLS LAST
    `);
    const rows = eventRows.rows as unknown as Array<{
      id: number | string | null;
      entity_type: string | null;
      entity_id: string | null;
      event_type: string | null;
      field: string | null;
      old_value: unknown;
      new_value: unknown;
      occurred_at: Date | string | null;
      category: ActivityCategory | null;
      total_changes: number;
      quantity_changes: number;
      line_item_changes: number;
      price_changes: number;
      balance_changes: number;
      status_changes: number;
      order_changes: number;
    }>;
    const pageRows = rows.filter((row) => row.id !== null);
    const hasMore = pageRows.length > limit;
    const events = pageRows.slice(0, limit);
    const toIso = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    };
    const totals = rows[0] ?? {
      total_changes: 0,
      quantity_changes: 0,
      line_item_changes: 0,
      price_changes: 0,
      balance_changes: 0,
      status_changes: 0,
      order_changes: 0,
    };
    res.json({
      order: {
        id: order.id,
        visualId: order.visual_id,
        orderType: order.order_type,
        ownerEmail: order.owner_email,
        invoiceAt: order.invoice_at,
      },
      range: {
        start: filters.activityStart,
        end: filters.activityEnd,
      },
      totals: {
        changes: Number(totals.total_changes ?? 0),
        byCategory: {
          quantity: Number(totals.quantity_changes ?? 0),
          lineItem: Number(totals.line_item_changes ?? 0),
          price: Number(totals.price_changes ?? 0),
          balance: Number(totals.balance_changes ?? 0),
          status: Number(totals.status_changes ?? 0),
          order: Number(totals.order_changes ?? 0),
        },
      },
      events: events.map((event) => ({
        id: Number(event.id),
        entityType: event.entity_type,
        entityId: event.entity_id,
        eventType: event.event_type,
        field: event.field,
        fieldLabel: activityFieldLabel(
          event.field,
          event.event_type as ActivityEventType,
        ),
        category: event.category,
        oldValue: event.old_value,
        newValue: event.new_value,
        occurredAt: toIso(event.occurred_at),
      })),
      pagination: {
        hasMore,
        nextBeforeId: hasMore
          ? Number(events[events.length - 1]?.id ?? 0)
          : null,
      },
    });
  })().catch((err) => {
    req.log.error({ err, orderId: req.params.orderId }, "Order activity detail failed");
    res.status(500).json({ error: "Failed to load order activity" });
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
  "/reports/category-breakdown",
  handler((orders) => ({
    stats: computeStats(orders),
    rows: lineItemBreakdown(orders, (li) => li.categoryName?.trim() || null, "Uncategorized"),
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
    const [statuses, brands, categories, colors, styles, tiers, owners] =
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
        db.execute(
          sql`SELECT DISTINCT owner_email AS v FROM pv_orders WHERE owner_email IS NOT NULL AND owner_email <> '' ORDER BY 1`,
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
      owners: vals(owners),
      paymentTypes: PAYMENT_TYPES,
    });
  })().catch((err) => {
    req.log.error({ err }, "Filter options failed");
    res.status(500).json({ error: "Report failed" });
  });
});

export default router;
export type { BreakdownRow };
