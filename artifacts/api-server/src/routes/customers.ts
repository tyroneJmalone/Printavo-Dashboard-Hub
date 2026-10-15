import { Router, type IRouter } from "express";
import { pool, db, chipplyStoresTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { requireAdmin } from "../middlewares/requireStaff";
import { storeJson } from "./chipply";
import {
  countLinkedInvoices,
  notChipplySql,
  chipplySql,
} from "../lib/chipply/matching";

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

/**
 * Map one pv_imprints row to a canonical decoration method. Printavo's
 * type_of_work is blank on ~57% of imprints, but the pricing-matrix name
 * ("Screen Printing - 8", "Embroidery - 5", "1st PRINT LOC - 2025", …)
 * usually carries the method instead — so we read whichever is present.
 * NULL = not derivable (blank goods, "Extras", …) → "Unspecified" bucket.
 */
const IMPRINT_METHOD_SQL = `CASE
  WHEN coalesce(nullif(i.type_of_work, ''), i.matrix_name, '') ILIKE '%screen print%'
    OR coalesce(nullif(i.type_of_work, ''), i.matrix_name, '') ILIKE '%print loc%'
    OR coalesce(nullif(i.type_of_work, ''), i.matrix_name, '') ILIKE '%byo print%'
    THEN 'Screen Printing'
  WHEN coalesce(nullif(i.type_of_work, ''), i.matrix_name, '') ILIKE '%embroider%'
    OR coalesce(nullif(i.type_of_work, ''), i.matrix_name, '') ILIKE '%byo emb%'
    THEN 'Embroidery'
  WHEN coalesce(nullif(i.type_of_work, ''), i.matrix_name, '') ILIKE '%heat%'
    THEN 'Heat Applied Graphics'
  WHEN coalesce(nullif(i.type_of_work, ''), i.matrix_name, '') ILIKE '%personalization%'
    THEN 'Personalization'
  ELSE NULL
END`;

/** Guard uuid inputs before ::uuid casts — otherwise Postgres 22P02 → 500. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escape ILIKE wildcards so a literal % or _ in the search term stays literal. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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
  if (req.query.searchScope !== undefined && !["all", "names"].includes(String(req.query.searchScope))) {
    res.status(400).json({ error: "searchScope must be all or names" });
    return;
  }
  const categoryId =
    typeof req.query.categoryId === "string" ? req.query.categoryId : "";
  if (categoryId && !UUID_RE.test(categoryId)) {
    res.status(400).json({ error: "categoryId must be a valid category id" });
    return;
  }
  const uncategorized = req.query.uncategorized === "true";
  const sort = req.query.sort === "name" ? "name" : "spend";
  // Cap 500 = bulk-assign limit, so "select all matching" can fetch one page.
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    // Match the company/primary contact, any linked contact, or keywords in
    // order nicknames. A secondary contact search still returns the parent
    // customer account (for example, Pat Traynor → MYA Baseball).
    where.push(req.query.searchScope === "names"
      ? `${DISPLAY_NAME_SQL} ILIKE $${params.length}`
      :
      `(${DISPLAY_NAME_SQL} ILIKE $${params.length}
        OR c.data->'primaryContact'->>'email' ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM pv_contacts ct
                    WHERE ct.customer_id = c.printavo_id
                      AND (ct.full_name ILIKE $${params.length}
                           OR ct.email ILIKE $${params.length}))
        OR EXISTS (SELECT 1 FROM pv_orders om
                    WHERE om.customer_id = c.printavo_id
                      AND om.nickname ILIKE $${params.length}))`,
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
          WHERE ${notChipplySql("nickname")}
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
          AND ${notChipplySql("o.nickname")}
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

// ── Customer profile (CC2) ──────────────────────────────────────────
// Declared LAST so the literal routes above (/customers/categories,
// /customers/assign, /customers/report) always win over the :id param.

router.get("/customers/:id", async (req, res) => {
  const id = String(req.params.id);
  // Printavo customer ids are numeric text — anything else is a 404, not a 500.
  if (!/^\d+$/.test(id)) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  // Optional order-history filters (stats/statuses/styles stay unfiltered).
  const statusFilter =
    typeof req.query.status === "string" && req.query.status.trim() !== ""
      ? req.query.status.trim()
      : null;
  const orderQ =
    typeof req.query.q === "string" && req.query.q.trim() !== ""
      ? req.query.q.trim().replace(/^#/, "") // allow "#2521" style input
      : null;
  try {
    const cr = await pool.query(
      `SELECT c.printavo_id,
              ${DISPLAY_NAME_SQL} AS display_name,
              nullif(c.company_name, '') AS company_name,
              c.data->'primaryContact'->>'fullName' AS contact_name,
              c.data->'primaryContact'->>'email' AS contact_email,
              c.data->'owner'->>'email' AS owner_email,
              c.data->'timestamps'->>'createdAt' AS customer_since,
              cm.category_id,
              cc.name AS category_name
         FROM pv_customers c
         LEFT JOIN customer_meta cm ON cm.printavo_customer_id = c.printavo_id
         LEFT JOIN customer_categories cc ON cc.id = cm.category_id
        WHERE c.printavo_id = $1`,
      [id],
    );
    if (cr.rows.length === 0) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const c = cr.rows[0];

    // Invoice-only stats (matching directory/report semantics) + quote count.
    const sr = await pool.query(
      `SELECT coalesce(sum(total) FILTER (WHERE order_type = 'invoice'), 0) AS lifetime_spend,
              count(*) FILTER (WHERE order_type = 'invoice')::int AS invoice_count,
              count(*) FILTER (WHERE order_type = 'quote')::int AS quote_count,
              coalesce(sum(total) FILTER (WHERE order_type = 'invoice'
                AND invoice_at >= date_trunc('year', current_date)), 0) AS ytd_spend,
              coalesce(sum(amount_outstanding) FILTER (WHERE order_type = 'invoice'), 0) AS outstanding,
              (min(invoice_at) FILTER (WHERE order_type = 'invoice'))::text AS first_order_at,
              (max(invoice_at) FILTER (WHERE order_type = 'invoice'))::text AS last_order_at
         FROM pv_orders
        WHERE customer_id = $1
          AND ${notChipplySql("nickname")}`,
      [id],
    );
    const s = sr.rows[0];

    // Ordering behavior: quantities + top styles (invoice line items) and the
    // status breakdown used by the order-history filter. All unfiltered.
    const [
      qtyR,
      stylesR,
      statusesR,
      chipplyQtyR,
      chipplyStylesR,
      methodsR,
      chipplyMethodsR,
    ] = await Promise.all([
      pool.query(
        `SELECT count(DISTINCT li.order_id)::int AS orders_with_items,
                coalesce(sum(li.items), 0)::bigint AS total_items
           FROM pv_line_items li
           JOIN pv_orders o ON o.printavo_id = li.order_id
          WHERE o.customer_id = $1 AND o.order_type = 'invoice'
            AND ${notChipplySql("o.nickname")}`,
        [id],
      ),
      pool.query(
        `SELECT nullif(li.brand, '') AS brand,
                li.item_number,
                count(DISTINCT li.order_id)::int AS order_count,
                coalesce(sum(li.items), 0)::bigint AS total_qty
           FROM pv_line_items li
           JOIN pv_orders o ON o.printavo_id = li.order_id
          WHERE o.customer_id = $1
            AND o.order_type = 'invoice'
            AND ${notChipplySql("o.nickname")}
            AND coalesce(li.item_number, '') <> ''
          GROUP BY 1, 2
          ORDER BY count(DISTINCT li.order_id) DESC, sum(li.items) DESC
          LIMIT 6`,
        [id],
      ),
      pool.query(
        `SELECT status_name, count(*)::int AS n
           FROM pv_orders
          WHERE customer_id = $1
            AND coalesce(status_name, '') <> ''
          GROUP BY 1
          ORDER BY 2 DESC, 1 ASC`,
        [id],
      ),
      // Chipply shell production — the flip side of the exclusions above.
      // Same data, surfaced separately so it never mixes with Printavo stats.
      pool.query(
        `SELECT count(*)::int AS shell_invoices,
                coalesce((SELECT sum(li.items)
                            FROM pv_line_items li
                            JOIN pv_orders o2 ON o2.printavo_id = li.order_id
                           WHERE o2.customer_id = $1
                             AND o2.order_type = 'invoice'
                             AND ${chipplySql("o2.nickname")}), 0)::bigint AS total_items
           FROM pv_orders
          WHERE customer_id = $1
            AND order_type = 'invoice'
            AND ${chipplySql("nickname")}`,
        [id],
      ),
      pool.query(
        `SELECT nullif(li.brand, '') AS brand,
                li.item_number,
                count(DISTINCT li.order_id)::int AS order_count,
                coalesce(sum(li.items), 0)::bigint AS total_qty
           FROM pv_line_items li
           JOIN pv_orders o ON o.printavo_id = li.order_id
          WHERE o.customer_id = $1
            AND o.order_type = 'invoice'
            AND ${chipplySql("o.nickname")}
            AND coalesce(li.item_number, '') <> ''
          GROUP BY 1, 2
          ORDER BY sum(li.items) DESC, count(DISTINCT li.order_id) DESC
          LIMIT 6`,
        [id],
      ),
      // Decoration-method breakdown (Printavo, shells excluded). Method is
      // derived per line-item GROUP from its imprints; a group's pieces count
      // once per distinct method (a garment that's both printed and
      // embroidered legitimately belongs to both buckets).
      pool.query(
        `WITH grp AS (
           SELECT g.printavo_id AS gid, g.order_id
             FROM pv_line_item_groups g
             JOIN pv_orders o ON o.printavo_id = g.order_id
            WHERE o.customer_id = $1
              AND o.order_type = 'invoice'
              AND ${notChipplySql("o.nickname")}
         ),
         gm AS (
           SELECT grp.gid, grp.order_id, coalesce(m.method, 'Unspecified') AS method
             FROM grp
             LEFT JOIN LATERAL (
               SELECT DISTINCT mm.method
                 FROM (SELECT ${IMPRINT_METHOD_SQL} AS method
                         FROM pv_imprints i
                        WHERE i.group_id = grp.gid) mm
                WHERE mm.method IS NOT NULL
             ) m ON true
         ),
         gp AS (
           SELECT li.group_id AS gid, coalesce(sum(li.items), 0) AS pcs
             FROM pv_line_items li
            WHERE li.group_id IN (SELECT gid FROM grp)
            GROUP BY 1
         )
         SELECT gm.method,
                count(DISTINCT gm.order_id)::int AS order_count,
                coalesce(sum(gp.pcs), 0)::bigint AS total_qty
           FROM gm
           LEFT JOIN gp ON gp.gid = gm.gid
          GROUP BY 1
          ORDER BY (gm.method = 'Unspecified') ASC, sum(gp.pcs) DESC NULLS LAST, 1`,
        [id],
      ),
      // Decoration-method breakdown (Chipply shells) — decoded from the
      // nickname method token before the colon ("553498 Fuel Summer EMB: …").
      // Real data uses EMB / HEAT / PRINT (plus rare SCREEN / SP / DTF /
      // ENGRAVED) — surveyed across all shell nicknames, not just one sample.
      pool.query(
        `SELECT x.method,
                count(*)::int AS order_count,
                coalesce(sum(p.pcs), 0)::bigint AS total_qty
           FROM (
             SELECT o.printavo_id,
                    CASE upper(substring(split_part(o.nickname, ':', 1) from '(?i)\\m(EMB|SP|DTF|HEAT|PRINT|SCREEN|ENGRAVED)\\M'))
                      WHEN 'EMB' THEN 'Embroidery'
                      WHEN 'SP' THEN 'Screen Printing'
                      WHEN 'PRINT' THEN 'Screen Printing'
                      WHEN 'SCREEN' THEN 'Screen Printing'
                      WHEN 'DTF' THEN 'Heat Applied Graphics'
                      WHEN 'HEAT' THEN 'Heat Applied Graphics'
                      WHEN 'ENGRAVED' THEN 'Engraving'
                      ELSE 'Unspecified'
                    END AS method
               FROM pv_orders o
              WHERE o.customer_id = $1
                AND o.order_type = 'invoice'
                AND ${chipplySql("o.nickname")}
           ) x
           LEFT JOIN LATERAL (
             SELECT coalesce(sum(li.items), 0) AS pcs
               FROM pv_line_items li
              WHERE li.order_id = x.printavo_id
           ) p ON true
          GROUP BY 1
          ORDER BY (x.method = 'Unspecified') ASC, sum(p.pcs) DESC NULLS LAST, 1`,
        [id],
      ),
    ]);

    // Most recent orders (both types, badge distinguishes) — newest first,
    // optionally filtered by status and/or nickname / order # keyword.
    const oFilters = ["customer_id = $1"];
    const oParams: unknown[] = [id];
    if (statusFilter) {
      oParams.push(statusFilter);
      oFilters.push(`status_name = $${oParams.length}`);
    }
    if (orderQ) {
      oParams.push(`%${escapeLike(orderQ)}%`);
      oFilters.push(
        `(nickname ILIKE $${oParams.length} OR visual_id::text ILIKE $${oParams.length})`,
      );
    }
    const or_ = await pool.query(
      `SELECT printavo_id, visual_id, order_type, nickname, status_name, total,
              coalesce(invoice_at::text, printavo_created_at::date::text) AS order_date,
              count(*) OVER ()::int AS total_rows
         FROM pv_orders
        WHERE ${oFilters.join(" AND ")}
        ORDER BY coalesce(invoice_at, printavo_created_at::date) DESC NULLS LAST,
                 visual_id DESC
        LIMIT 100`,
      oParams,
    );

    const invoiceCount = s.invoice_count as number;
    const lifetimeSpend = Number(s.lifetime_spend);

    // Ordering cadence derived from the invoice span (JS-side, dates are
    // already "YYYY-MM-DD" text). Needs at least 2 invoices to be meaningful.
    const firstAt = s.first_order_at ? new Date(String(s.first_order_at)) : null;
    const lastAt = s.last_order_at ? new Date(String(s.last_order_at)) : null;
    let ordersPerMonth: number | null = null;
    let avgDaysBetween: number | null = null;
    if (firstAt && lastAt && invoiceCount > 1) {
      const spanDays = Math.max(
        1,
        (lastAt.getTime() - firstAt.getTime()) / 86_400_000,
      );
      avgDaysBetween = spanDays / (invoiceCount - 1);
      // Need at least ~a month of history for a per-month rate to be
      // meaningful — otherwise 2 same-week invoices read as "8+/mo".
      if (spanDays >= 30.44) {
        ordersPerMonth = invoiceCount / (spanDays / 30.44);
      }
    }

    const qty = qtyR.rows[0];
    const ordersWithItems = qty.orders_with_items as number;
    const totalItems = Number(qty.total_items);

    // Chipply web stores assigned to this customer. Chipply dollars are
    // shown in their own section — NEVER summed into Printavo spend stats.
    const chipplyRows = await db
      .select()
      .from(chipplyStoresTable)
      .where(
        and(
          eq(chipplyStoresTable.pvCustomerId, id),
          eq(chipplyStoresTable.archived, false),
        ),
      )
      .orderBy(desc(chipplyStoresTable.createdAt));
    const chipplyCounts = await countLinkedInvoices(
      chipplyRows.map((r) => r.eventId).filter((v): v is string => !!v),
    );
    const chipplyCompany = new Map([
      [id, ((c.company_name as string | null) ?? "") as string],
    ]);

    res.json({
      printavoId: c.printavo_id as string,
      displayName: c.display_name as string,
      companyName: (c.company_name as string | null) ?? null,
      contactName: (c.contact_name as string | null) ?? null,
      contactEmail: (c.contact_email as string | null) ?? null,
      ownerEmail: (c.owner_email as string | null) ?? null,
      customerSince: c.customer_since
        ? String(c.customer_since).slice(0, 10)
        : null,
      categoryId: (c.category_id as string | null) ?? null,
      categoryName: (c.category_name as string | null) ?? null,
      stats: {
        lifetimeSpend,
        ytdSpend: Number(s.ytd_spend),
        invoiceCount,
        quoteCount: s.quote_count as number,
        avgOrder: invoiceCount > 0 ? lifetimeSpend / invoiceCount : 0,
        outstanding: Number(s.outstanding),
        firstOrderAt: (s.first_order_at as string | null) ?? null,
        lastOrderAt: (s.last_order_at as string | null) ?? null,
        ordersPerMonth,
        avgDaysBetween,
        avgOrderQty: ordersWithItems > 0 ? totalItems / ordersWithItems : null,
        totalItems,
      },
      topStyles: stylesR.rows.map((row) => ({
        brand: (row.brand as string | null) ?? null,
        itemNumber: row.item_number as string,
        orderCount: row.order_count as number,
        totalQty: Number(row.total_qty),
      })),
      statuses: statusesR.rows.map((row) => ({
        name: row.status_name as string,
        count: row.n as number,
      })),
      methodBreakdown: methodsR.rows.map((row) => ({
        method: row.method as string,
        orderCount: row.order_count as number,
        totalQty: Number(row.total_qty),
      })),
      chipplyProduction: {
        invoiceCount: chipplyQtyR.rows[0].shell_invoices as number,
        totalItems: Number(chipplyQtyR.rows[0].total_items),
        topStyles: chipplyStylesR.rows.map((row) => ({
          brand: (row.brand as string | null) ?? null,
          itemNumber: row.item_number as string,
          orderCount: row.order_count as number,
          totalQty: Number(row.total_qty),
        })),
        methods: chipplyMethodsR.rows.map((row) => ({
          method: row.method as string,
          orderCount: row.order_count as number,
          totalQty: Number(row.total_qty),
        })),
      },
      ordersTotal:
        or_.rows.length > 0 ? (or_.rows[0].total_rows as number) : 0,
      orders: or_.rows.map((row) => ({
        printavoId: row.printavo_id as string,
        visualId: row.visual_id as number,
        orderType: row.order_type as string,
        nickname: (row.nickname as string | null) ?? null,
        statusName: (row.status_name as string | null) ?? null,
        total: row.total == null ? null : Number(row.total),
        orderDate: (row.order_date as string | null) ?? null,
      })),
      chipplyStores: chipplyRows.map((s) => ({
        store: storeJson(s, chipplyCompany),
        linkedInvoiceCount: s.eventId
          ? (chipplyCounts.get(s.eventId) ?? 0)
          : 0,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "customer profile failed");
    res.status(500).json({ error: "Failed to load customer profile" });
  }
});

export default router;
