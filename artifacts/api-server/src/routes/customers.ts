import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireStaff";

/**
 * Client 360 — customer directory, niche categories, and niche reporting.
 * Mounted behind requireStaff (routes/index.ts); category MANAGEMENT is
 * admin-only per route, assignment is staff-level.
 *
 * customer_meta/customer_categories are OUR tables (no FK to pv_*).
 * Aggregations use pv_orders hot columns (customer_id, total, order_type,
 * invoice_at). Revenue semantics match the existing reports: invoices only —
 * quotes are excluded everywhere.
 */
const router: IRouter = Router();

/** Display name: company name, falling back to the primary contact. */
const DISPLAY_NAME_SQL = `coalesce(nullif(c.company_name, ''), c.data->'primaryContact'->>'fullName', '(no name)')`;

/** Guard uuid inputs before ::uuid casts — otherwise Postgres 22P02 → 500. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Categories ───────────────────────────────────────────────────────

router.get("/customers/categories", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cc.id, cc.name, cc.active, cc.sort_order,
              count(cm.printavo_customer_id)::int AS assigned_count
         FROM customer_categories cc
         LEFT JOIN customer_meta cm ON cm.category_id = cc.id
        GROUP BY cc.id
        ORDER BY cc.sort_order, cc.name`,
    );
    res.json({
      categories: r.rows.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        active: row.active as boolean,
        sortOrder: row.sort_order as number,
        assignedCount: row.assigned_count as number,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "list categories failed");
    res.status(500).json({ error: "Failed to load categories" });
  }
});

router.post("/customers/categories", requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 80) {
    res.status(400).json({ error: "Category name is required (max 80 chars)" });
    return;
  }
  try {
    const r = await pool.query(
      `INSERT INTO customer_categories (name, sort_order)
       VALUES ($1, (SELECT coalesce(max(sort_order), 0) + 10 FROM customer_categories))
       RETURNING id, name, active, sort_order`,
      [name],
    );
    const row = r.rows[0];
    res.status(201).json({
      id: row.id as string,
      name: row.name as string,
      active: row.active as boolean,
      sortOrder: row.sort_order as number,
      assignedCount: 0,
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A category with that name already exists" });
      return;
    }
    req.log.error({ err }, "create category failed");
    res.status(500).json({ error: "Failed to create category" });
  }
});

router.patch("/customers/categories/:id", requireAdmin, async (req, res) => {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof req.body?.name === "string") {
    const name = req.body.name.trim();
    if (!name || name.length > 80) {
      res.status(400).json({ error: "Category name is required (max 80 chars)" });
      return;
    }
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (typeof req.body?.active === "boolean") {
    params.push(req.body.active);
    sets.push(`active = $${params.length}`);
  }
  if (sets.length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  if (!UUID_RE.test(String(req.params.id))) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  params.push(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE customer_categories SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, name, active, sort_order`,
      params,
    );
    if (r.rows.length === 0) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
    const row = r.rows[0];
    res.json({
      id: row.id as string,
      name: row.name as string,
      active: row.active as boolean,
      sortOrder: row.sort_order as number,
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A category with that name already exists" });
      return;
    }
    req.log.error({ err }, "update category failed");
    res.status(500).json({ error: "Failed to update category" });
  }
});

// ── Directory ────────────────────────────────────────────────────────

router.get("/customers", async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const categoryId =
    typeof req.query.categoryId === "string" ? req.query.categoryId : "";
  if (categoryId && !UUID_RE.test(categoryId)) {
    res.status(400).json({ error: "categoryId must be a valid category id" });
    return;
  }
  const uncategorized = req.query.uncategorized === "true";
  const sort = req.query.sort === "name" ? "name" : "spend";
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(${DISPLAY_NAME_SQL} ILIKE $${params.length} OR c.data->'primaryContact'->>'email' ILIKE $${params.length})`,
    );
  }
  if (uncategorized) {
    where.push(`cm.category_id IS NULL`);
  } else if (categoryId) {
    params.push(categoryId);
    where.push(`cm.category_id = $${params.length}::uuid`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  // printavo_id tiebreaker keeps LIMIT/OFFSET pagination deterministic
  // (thousands of customers tie at $0 lifetime spend).
  const orderSql =
    sort === "name"
      ? `ORDER BY ${DISPLAY_NAME_SQL} ASC, c.printavo_id`
      : `ORDER BY coalesce(s.lifetime_spend, 0) DESC, c.printavo_id`;

  try {
    const r = await pool.query(
      `WITH spend AS (
         SELECT customer_id,
                sum(total) FILTER (WHERE order_type = 'invoice') AS lifetime_spend,
                count(*) FILTER (WHERE order_type = 'invoice')::int AS order_count,
                max(invoice_at) FILTER (WHERE order_type = 'invoice') AS last_order_at
           FROM pv_orders
          GROUP BY customer_id
       )
       SELECT c.printavo_id,
              ${DISPLAY_NAME_SQL} AS display_name,
              c.data->'primaryContact'->>'fullName' AS contact_name,
              c.data->'primaryContact'->>'email' AS contact_email,
              cm.category_id,
              coalesce(s.lifetime_spend, 0) AS lifetime_spend,
              coalesce(s.order_count, 0) AS order_count,
              s.last_order_at,
              count(*) OVER ()::int AS total_rows
         FROM pv_customers c
         LEFT JOIN customer_meta cm ON cm.printavo_customer_id = c.printavo_id
         LEFT JOIN spend s ON s.customer_id = c.printavo_id
         ${whereSql}
         ${orderSql}
         LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({
      total: r.rows.length > 0 ? (r.rows[0].total_rows as number) : 0,
      customers: r.rows.map((row) => ({
        printavoId: row.printavo_id as string,
        displayName: row.display_name as string,
        contactName: (row.contact_name as string | null) ?? null,
        contactEmail: (row.contact_email as string | null) ?? null,
        categoryId: (row.category_id as string | null) ?? null,
        lifetimeSpend: Number(row.lifetime_spend),
        orderCount: row.order_count as number,
        lastOrderAt: row.last_order_at
          ? new Date(row.last_order_at as string).toISOString().slice(0, 10)
          : null,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "list customers failed");
    res.status(500).json({ error: "Failed to load customers" });
  }
});

// ── Assignment ───────────────────────────────────────────────────────

async function assertAssignableCategory(categoryId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM customer_categories WHERE id = $1::uuid AND active = true`,
    [categoryId],
  );
  return r.rows.length > 0;
}

router.post("/customers/assign", async (req, res) => {
  const ids: unknown = req.body?.customerIds;
  const categoryId: unknown = req.body?.categoryId ?? null;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 500 ||
    !ids.every((id) => typeof id === "string" && id.length > 0)
  ) {
    res.status(400).json({ error: "customerIds must be 1-500 Printavo customer ids" });
    return;
  }
  if (categoryId !== null && typeof categoryId !== "string") {
    res.status(400).json({ error: "categoryId must be a category id or null" });
    return;
  }
  try {
    if (
      typeof categoryId === "string" &&
      (!UUID_RE.test(categoryId) || !(await assertAssignableCategory(categoryId)))
    ) {
      res.status(400).json({ error: "Unknown or inactive category" });
      return;
    }
    // Only accept ids that exist in pv_customers (plain-text key, no FK).
    const r = await pool.query(
      `INSERT INTO customer_meta (printavo_customer_id, category_id, assigned_by_email, assigned_at)
       SELECT c.printavo_id, $2::uuid, $3, now()
         FROM pv_customers c
        WHERE c.printavo_id = ANY($1::text[])
       ON CONFLICT (printavo_customer_id) DO UPDATE
          SET category_id = excluded.category_id,
              assigned_by_email = excluded.assigned_by_email,
              assigned_at = excluded.assigned_at,
              updated_at = now()`,
      [ids, categoryId, req.staff?.email ?? null],
    );
    res.json({ assigned: r.rowCount ?? 0 });
  } catch (err) {
    req.log.error({ err }, "assign category failed");
    res.status(500).json({ error: "Failed to assign category" });
  }
});

// ── Niche report ─────────────────────────────────────────────────────

router.get("/customers/report", async (req, res) => {
  const range = typeof req.query.range === "string" ? req.query.range : "all";
  let startDate: string | null = null;
  let endDate: string | null = null;
  const today = new Date();
  if (range === "ytd") {
    startDate = `${today.getFullYear()}-01-01`;
  } else if (range === "last12") {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - 1);
    startDate = d.toISOString().slice(0, 10);
  } else if (range === "custom") {
    const s = typeof req.query.start === "string" ? req.query.start : "";
    const e = typeof req.query.end === "string" ? req.query.end : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
      res.status(400).json({ error: "custom range requires start and end as YYYY-MM-DD" });
      return;
    }
    startDate = s;
    endDate = e;
  } else if (range !== "all") {
    res.status(400).json({ error: "range must be all | ytd | last12 | custom" });
    return;
  }

  const params: unknown[] = [];
  let dateFilter = "";
  if (startDate) {
    params.push(startDate);
    dateFilter += ` AND o.invoice_at >= $${params.length}::date`;
  }
  if (endDate) {
    params.push(endDate);
    dateFilter += ` AND o.invoice_at <= $${params.length}::date`;
  }

  try {
    const r = await pool.query(
      `SELECT cc.id AS category_id,
              coalesce(cc.name, 'Uncategorized') AS category_name,
              coalesce(sum(o.total), 0) AS revenue,
              count(o.printavo_id)::int AS order_count,
              count(DISTINCT o.customer_id)::int AS customer_count
         FROM pv_orders o
         LEFT JOIN customer_meta cm ON cm.printavo_customer_id = o.customer_id
         LEFT JOIN customer_categories cc ON cc.id = cm.category_id
        WHERE o.order_type = 'invoice'${dateFilter}
        GROUP BY cc.id, cc.name
        ORDER BY sum(o.total) DESC NULLS LAST`,
      params,
    );
    const catAgg = await pool.query(
      `SELECT count(*)::int AS total,
              count(cm.category_id)::int AS categorized
         FROM pv_customers c
         LEFT JOIN customer_meta cm ON cm.printavo_customer_id = c.printavo_id`,
    );
    res.json({
      range,
      startDate,
      endDate,
      coverage: {
        totalCustomers: catAgg.rows[0].total as number,
        categorized: catAgg.rows[0].categorized as number,
      },
      rows: r.rows.map((row) => ({
        categoryId: (row.category_id as string | null) ?? null,
        categoryName: row.category_name as string,
        revenue: Number(row.revenue),
        orderCount: row.order_count as number,
        customerCount: row.customer_count as number,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "niche report failed");
    res.status(500).json({ error: "Failed to build niche report" });
  }
});

export default router;
