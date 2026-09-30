import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { z } from "zod";

const router: IRouter = Router();

export const PIPELINE_STAGES = [
  { id: "quote", label: "Quote" },
  { id: "quote_sent", label: "Quote Sent" },
  { id: "follow_up_1", label: "Follow Up 1" },
  { id: "follow_up_2", label: "Follow Up 2" },
  { id: "nurturing", label: "Nurturing" },
  { id: "art", label: "Art" },
  { id: "other", label: "Other" },
  { id: "won", label: "Won" },
  { id: "done", label: "Done" },
  { id: "receivables", label: "Receivables" },
  { id: "dead", label: "Dead" },
  { id: "contract_dead_archive", label: "Contract Dead/Archive" },
  { id: "archive", label: "Archive/Dup/Ref" },
] as const;

const STAGE_IDS = PIPELINE_STAGES.map((stage) => stage.id);
const ACTIVE_STAGES = [
  "quote", "quote_sent", "follow_up_1", "follow_up_2",
  "nurturing", "art", "other",
];
const SORT_IDS = [
  "visualId", "customerName", "customerEmail", "nickname", "ownerEmail", "stage", "createdAt",
  "invoiceAt", "productionDueAt", "customerDueAt", "qty", "total", "balanceDue",
  "statusName", "statusSince",
] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const configSchema = z.object({
  q: z.string().max(500).optional(),
  owner: z.string().max(320).optional(),
  stage: z.enum(["active", ...STAGE_IDS] as [string, ...string[]]).optional(),
  wonDays: z.number().int().min(7).max(365).optional(),
  createdFrom: z.string().regex(DATE_RE).optional(),
  createdTo: z.string().regex(DATE_RE).optional(),
  invoiceFrom: z.string().regex(DATE_RE).optional(),
  invoiceTo: z.string().regex(DATE_RE).optional(),
  productionDueFrom: z.string().regex(DATE_RE).optional(),
  productionDueTo: z.string().regex(DATE_RE).optional(),
  customerDueFrom: z.string().regex(DATE_RE).optional(),
  customerDueTo: z.string().regex(DATE_RE).optional(),
  sort: z.enum(SORT_IDS).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
}).strict().superRefine((value, ctx) => {
  for (const key of [
    "createdFrom", "createdTo", "invoiceFrom", "invoiceTo",
    "productionDueFrom", "productionDueTo", "customerDueFrom", "customerDueTo",
  ] as const) {
    if (!validDate(value[key])) {
      ctx.addIssue({ code: "custom", path: [key], message: "Invalid calendar date" });
    }
  }
  for (const [from, to] of [
    ["createdFrom", "createdTo"],
    ["invoiceFrom", "invoiceTo"],
    ["productionDueFrom", "productionDueTo"],
    ["customerDueFrom", "customerDueTo"],
  ] as const) {
    if (value[from] && value[to] && value[from] > value[to]) {
      ctx.addIssue({ code: "custom", path: [to], message: `${from} must be on or before ${to}` });
    }
  }
});
const viewInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  config: configSchema,
  isDefault: z.boolean().optional(),
}).strict();
const viewUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  config: configSchema.optional(),
  isDefault: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

const NORM_SQL = `lower(regexp_replace(coalesce(o.status_name, ''), '\\s+', ' ', 'g'))`;
const STAGE_CASE_SQL = `CASE
  WHEN n.norm LIKE '%contract%' AND (n.norm ~ '\\mdead\\M' OR n.norm LIKE '%archive%')
    THEN 'contract_dead_archive'
  WHEN n.norm ~ '\\mdead\\M' THEN 'dead'
  WHEN n.norm LIKE '%archive%' OR n.norm LIKE '%duplicat%' OR n.norm LIKE '%reference%'
    THEN 'archive'
  WHEN n.norm LIKE '%nurtur%' OR n.norm LIKE '%approved%' OR n.norm ~ '\\yart'
    THEN 'nurturing'
  WHEN n.norm LIKE '%proof%' OR n.norm LIKE '%digitiz%'
    OR n.norm LIKE '%separat%' OR n.norm LIKE '%png%' OR n.norm LIKE '%revision%'
    THEN 'art'
  WHEN n.norm LIKE '%complete%' OR n.norm LIKE '%picked up%'
    OR n.norm LIKE '%shipped%' OR n.norm LIKE '%delivered%'
    OR n.norm LIKE '%billed%' THEN 'done'
  WHEN n.norm LIKE '%waiting 4 blanks%' OR n.norm LIKE '%ready to go%'
    OR n.norm LIKE '%ready 2 go%' OR n.norm LIKE '%ready 4 production%'
    OR n.norm LIKE '%ready 2 pick/pack%'
    OR n.norm LIKE '%need to order%' OR n.norm LIKE '%need 2 order%' THEN 'won'
  WHEN n.norm LIKE '%follow up 2%' THEN 'follow_up_2'
  WHEN n.norm LIKE '%follow up 1%' THEN 'follow_up_1'
  WHEN n.norm LIKE '%quote%' AND n.norm LIKE '%sent%' THEN 'quote_sent'
  WHEN n.norm LIKE '%quote%' THEN 'quote'
  ELSE NULL
END`;

/** Share the exact pipeline stage rules with observed dashboard transitions. */
export function pipelineStageSql(normalizedStatusSql: string): string {
  return STAGE_CASE_SQL.replaceAll("n.norm", normalizedStatusSql);
}

/**
 * $1 wonDays, $2 owner, $3 escaped literal search, $4..$11 date bounds,
 * $12 true when an explicit date range overrides the implicit wonDays cutoff.
 */
const FILTERED_CTE = `WITH base AS (
  SELECT o.printavo_id, o.visual_id, o.order_type, o.status_name, o.nickname,
         coalesce(o.total, 0)::float8 AS total,
         coalesce(o.amount_outstanding, 0)::float8 AS balance_due, o.customer_id,
         coalesce(nullif(o.customer_company, ''), o.contact_name) AS customer_name,
         o.customer_company, o.contact_name, o.contact_email AS customer_email,
         o.owner_email, o.printavo_created_at,
         o.invoice_at, o.production_due_at, o.customer_due_at, o.first_seen_at,
         coalesce(nullif(o.data->>'totalQuantity', '')::int, 0) AS qty,
         CASE WHEN o.order_type = 'quote'
              THEN coalesce(${STAGE_CASE_SQL}, 'other')
              ELSE ${STAGE_CASE_SQL} END AS stage_id
    FROM pv_orders o
    CROSS JOIN LATERAL (SELECT ${NORM_SQL} AS norm) n
   WHERE n.norm NOT LIKE '%merch store source%'
), included AS (
  SELECT * FROM base
   WHERE stage_id IS NOT NULL
     AND (stage_id = 'nurturing'
       OR (order_type = 'quote' AND stage_id NOT IN ('won', 'done'))
       OR (stage_id IN ('won', 'done')
         AND ($12::boolean OR printavo_created_at >= now() - make_interval(days => $1::int))))
), filtered AS (
  SELECT i.* FROM included i
   WHERE ($2::text IS NULL OR lower(coalesce(i.owner_email, '')) = $2)
     AND ($4::date IS NULL OR (i.printavo_created_at AT TIME ZONE 'America/New_York')::date >= $4)
     AND ($5::date IS NULL OR (i.printavo_created_at AT TIME ZONE 'America/New_York')::date <= $5)
     AND ($6::date IS NULL OR i.invoice_at >= $6)
     AND ($7::date IS NULL OR i.invoice_at <= $7)
     AND ($8::date IS NULL OR (i.production_due_at AT TIME ZONE 'UTC')::date >= $8)
     AND ($9::date IS NULL OR (i.production_due_at AT TIME ZONE 'UTC')::date <= $9)
     AND ($10::date IS NULL OR (i.customer_due_at AT TIME ZONE 'UTC')::date >= $10)
     AND ($11::date IS NULL OR (i.customer_due_at AT TIME ZONE 'UTC')::date <= $11)
     AND ($3::text IS NULL
       OR i.visual_id::text ILIKE $3 ESCAPE '\\'
       OR coalesce(i.nickname, '') ILIKE $3 ESCAPE '\\'
       OR coalesce(i.customer_name, '') ILIKE $3 ESCAPE '\\'
       OR coalesce(i.contact_name, '') ILIKE $3 ESCAPE '\\'
        OR coalesce(i.customer_email, '') ILIKE $3 ESCAPE '\\'
       OR coalesce(i.customer_company, '') ILIKE $3 ESCAPE '\\'
       OR EXISTS (
         SELECT 1 FROM pv_customers c
          WHERE c.printavo_id = i.customer_id
            AND coalesce(c.company_name, '') ILIKE $3 ESCAPE '\\'
       ))
)`;

function intParam(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
}
function stringParam(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}
function validDate(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
export function literalLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}
function serializeView(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    config: row.config,
    isDefault: row.is_default,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

router.get("/pipeline/views", async (req, res): Promise<void> => {
  const result = await pool.query(
    `SELECT id, name, config, is_default, created_at, updated_at
       FROM pipeline_views WHERE staff_id = $1
      ORDER BY is_default DESC, created_at, id`,
    [req.staff!.id],
  );
  res.json(result.rows.map(serializeView));
});

router.post("/pipeline/views", async (req, res): Promise<void> => {
  const parsed = viewInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pipeline-views:${req.staff!.id}`]);
    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pipeline_views WHERE staff_id = $1",
      [req.staff!.id],
    );
    const makeDefault = parsed.data.isDefault === true || count.rows[0].count === 0;
    if (makeDefault) {
      await client.query(
        "UPDATE pipeline_views SET is_default=false, updated_at=now() WHERE staff_id=$1 AND is_default",
        [req.staff!.id],
      );
    }
    const inserted = await client.query(
      `INSERT INTO pipeline_views (staff_id,name,config,is_default)
       VALUES ($1,$2,$3::jsonb,$4)
       RETURNING id,name,config,is_default,created_at,updated_at`,
      [req.staff!.id, parsed.data.name, JSON.stringify(parsed.data.config), makeDefault],
    );
    await client.query("COMMIT");
    res.status(201).json(serializeView(inserted.rows[0]));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.patch("/pipeline/views/:id", async (req, res): Promise<void> => {
  const parsed = viewUpdateSchema.safeParse(req.body);
  const id = typeof req.params.id === "string" ? req.params.id : "";
  if (!z.string().uuid().safeParse(id).success || !parsed.success) {
    res.status(400).json({ error: parsed.success ? "Invalid view id" : parsed.error.message });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pipeline-views:${req.staff!.id}`]);
    const owned = await client.query(
      "SELECT id FROM pipeline_views WHERE staff_id=$1 AND id=$2",
      [req.staff!.id, id],
    );
    if (!owned.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Pipeline view not found" });
      return;
    }
    if (parsed.data.isDefault === true) {
      await client.query(
        "UPDATE pipeline_views SET is_default=false, updated_at=now() WHERE staff_id=$1 AND is_default",
        [req.staff!.id],
      );
    }
    const updated = await client.query(
      `UPDATE pipeline_views SET
         name=coalesce($3,name), config=coalesce($4::jsonb,config),
         is_default=coalesce($5,is_default), updated_at=now()
       WHERE staff_id=$1 AND id=$2
       RETURNING id,name,config,is_default,created_at,updated_at`,
      [
        req.staff!.id, id, parsed.data.name ?? null,
        parsed.data.config ? JSON.stringify(parsed.data.config) : null,
        parsed.data.isDefault ?? null,
      ],
    );
    if (!updated.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Pipeline view not found" });
      return;
    }
    await client.query("COMMIT");
    res.json(serializeView(updated.rows[0]));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.delete("/pipeline/views/:id", async (req, res): Promise<void> => {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  if (!z.string().uuid().safeParse(id).success) {
    res.status(400).json({ error: "Invalid view id" });
    return;
  }
  const deleted = await pool.query(
    "DELETE FROM pipeline_views WHERE staff_id=$1 AND id=$2 RETURNING id",
    [req.staff!.id, id],
  );
  if (!deleted.rows[0]) {
    res.status(404).json({ error: "Pipeline view not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/pipeline", async (req, res): Promise<void> => {
  try {
    const scalarFilterKeys = [
      "owner", "q", "stage", "sort", "direction",
      "createdFrom", "createdTo", "invoiceFrom", "invoiceTo",
      "productionDueFrom", "productionDueTo", "customerDueFrom", "customerDueTo",
    ] as const;
    if (scalarFilterKeys.some((key) =>
      req.query[key] !== undefined && typeof req.query[key] !== "string"
    )) {
      res.status(400).json({ error: "Invalid pipeline filters" });
      return;
    }
    const wonDays = intParam(req.query.wonDays, 90, 7, 365);
    const limit = intParam(req.query.limit, 200, 1, 500);
    const offset = intParam(req.query.offset, 0, 0, 1_000_000);
    const owner = stringParam(req.query.owner)?.trim().toLowerCase() || null;
    const q = stringParam(req.query.q)?.trim() || null;
    const stage = stringParam(req.query.stage) ?? "active";
    const sort = stringParam(req.query.sort);
    const direction = stringParam(req.query.direction) ?? "asc";
    const dates = {
      createdFrom: stringParam(req.query.createdFrom),
      createdTo: stringParam(req.query.createdTo),
      invoiceFrom: stringParam(req.query.invoiceFrom),
      invoiceTo: stringParam(req.query.invoiceTo),
      productionDueFrom: stringParam(req.query.productionDueFrom),
      productionDueTo: stringParam(req.query.productionDueTo),
      customerDueFrom: stringParam(req.query.customerDueFrom),
      customerDueTo: stringParam(req.query.customerDueTo),
    };
    if (
      (stage !== "active" && !STAGE_IDS.includes(stage as never))
      || (sort !== undefined && !SORT_IDS.includes(sort as (typeof SORT_IDS)[number]))
      || !["asc", "desc"].includes(direction)
      || Boolean(q && q.length > 500)
      || Boolean(owner && owner.length > 320)
      || Object.values(dates).some((date) => !validDate(date))
    ) {
      res.status(400).json({ error: "Invalid pipeline filters" });
      return;
    }
    for (const [from, to] of [
      [dates.createdFrom, dates.createdTo], [dates.invoiceFrom, dates.invoiceTo],
      [dates.productionDueFrom, dates.productionDueTo],
      [dates.customerDueFrom, dates.customerDueTo],
    ]) {
      if (from && to && from > to) {
        res.status(400).json({ error: "Date range start must not be after end" });
        return;
      }
    }
    const rowStages = stage === "active"
      ? ACTIVE_STAGES
      : stage === "receivables" ? ["won", "done"] : [stage];
    const values = [
      wonDays, owner, q ? literalLikePattern(q) : null,
      dates.createdFrom ?? null, dates.createdTo ?? null,
      dates.invoiceFrom ?? null, dates.invoiceTo ?? null,
      dates.productionDueFrom ?? null, dates.productionDueTo ?? null,
      dates.customerDueFrom ?? null, dates.customerDueTo ?? null,
      Object.values(dates).some(Boolean) || stage === "receivables",
    ];
    const sortExpressions: Record<string, string> = {
      visualId: "i.visual_id",
      customerName: "lower(i.customer_name)",
      customerEmail: "lower(i.customer_email)",
      nickname: "lower(i.nickname)",
      ownerEmail: "lower(i.owner_email)",
      stage: "array_position($14::text[],i.stage_id)",
      createdAt: "i.printavo_created_at",
      invoiceAt: "i.invoice_at",
      productionDueAt: "i.production_due_at",
      customerDueAt: "i.customer_due_at",
      qty: "i.qty",
      total: "i.total",
      balanceDue: "i.balance_due",
      statusName: "lower(i.status_name)",
      statusSince: "status_since",
    };
    // "In Status" displays elapsed age, the inverse of the entry timestamp.
    const sqlDirection = sort === "statusSince"
      ? (direction === "asc" ? "DESC" : "ASC")
      : direction.toUpperCase();
    const orderSql = sort
      ? `${sortExpressions[sort]} ${sqlDirection} NULLS LAST,
         i.visual_id ASC NULLS LAST, i.printavo_id ASC`
      : `array_position($14::text[],i.stage_id), status_since ASC NULLS LAST,
         i.visual_id ASC, i.printavo_id ASC`;

    const ownerValues = [...values];
    ownerValues[1] = null;
    const ownerReceivableFilter = stage === "receivables"
      ? "AND order_type='invoice' AND stage_id IN ('won','done') AND balance_due > 0"
      : "";
    const ownersQ = pool.query(
      `${FILTERED_CTE}
       SELECT owner_email,count(*)::int AS count FROM filtered
        WHERE owner_email IS NOT NULL ${ownerReceivableFilter} GROUP BY owner_email
        ORDER BY count DESC,owner_email`,
      ownerValues,
    );
    const stagesQ = pool.query(
      `${FILTERED_CTE}
       SELECT stage_id,count(*)::int AS count,
              coalesce(sum(total),0)::float8 AS amount
         FROM filtered GROUP BY stage_id`,
      values,
    );
    const receivableValues = [...values];
    receivableValues[11] = true;
    const receivablesQ = pool.query(
      `${FILTERED_CTE}
       SELECT count(*)::int AS count,
              coalesce(sum(balance_due),0)::float8 AS amount
         FROM filtered
        WHERE order_type='invoice' AND stage_id IN ('won','done') AND balance_due > 0`,
      receivableValues,
    );
    const receivableRowFilter = stage === "receivables"
      ? "AND i.order_type='invoice' AND i.balance_due > 0"
      : "";
    const rowsQ = pool.query(
      `${FILTERED_CTE}
       SELECT i.*,
         coalesce(ev.occurred_at,
           CASE WHEN i.printavo_created_at >= i.first_seen_at - interval '2 days'
                THEN i.printavo_created_at ELSE i.first_seen_at END) AS status_since,
         (ev.occurred_at IS NOT NULL
          OR i.printavo_created_at >= i.first_seen_at - interval '2 days') AS status_since_exact,
         count(*) OVER ()::int AS total_rows
       FROM filtered i
       LEFT JOIN LATERAL (
         SELECT ce.occurred_at FROM change_events ce
          WHERE ce.entity_type='order' AND ce.field='status'
            AND ce.entity_id=i.printavo_id
          ORDER BY ce.occurred_at DESC LIMIT 1
       ) ev ON true
        WHERE i.stage_id=ANY($13::text[]) ${receivableRowFilter}
          AND cardinality($14::text[]) >= 0
       ORDER BY ${orderSql} LIMIT $15 OFFSET $16`,
      [...values, rowStages, STAGE_IDS, limit, offset],
    );
    const [ownersR, stagesR, receivablesR, rowsR] = await Promise.all([
      ownersQ, stagesQ, receivablesQ, rowsQ,
    ]);
    const stageCounts = new Map(stagesR.rows.map((row) => [
      row.stage_id as string,
      { count: row.count as number, amount: row.amount as number },
    ]));
    res.json({
      stage,
      wonDays,
      owners: ownersR.rows.map((row) => ({
        email: row.owner_email as string,
        count: row.count as number,
      })),
      stages: PIPELINE_STAGES.map((item) => ({
        ...item,
        count: item.id === "receivables"
          ? (receivablesR.rows[0]?.count as number) ?? 0
          : stageCounts.get(item.id)?.count ?? 0,
        amount: item.id === "receivables"
          ? (receivablesR.rows[0]?.amount as number) ?? 0
          : stageCounts.get(item.id)?.amount ?? 0,
      })),
      total: (rowsR.rows[0]?.total_rows as number) ?? 0,
      limit,
      offset,
      rows: rowsR.rows.map((row) => ({
        id: row.printavo_id as string,
        visualId: row.visual_id as number,
        orderType: row.order_type as string,
        stageId: row.stage_id as string,
        statusName: row.status_name as string,
        nickname: (row.nickname as string | null) ?? null,
        customerId: (row.customer_id as string | null) ?? null,
        customerName: (row.customer_name as string | null) ?? null,
        customerEmail: (row.customer_email as string | null) ?? null,
        ownerEmail: (row.owner_email as string | null) ?? null,
        createdAt: row.printavo_created_at
          ? (row.printavo_created_at as Date).toISOString() : null,
        invoiceAt: (row.invoice_at as string | null) ?? null,
        productionDueAt: row.production_due_at
          ? (row.production_due_at as Date).toISOString() : null,
        customerDueAt: row.customer_due_at
          ? (row.customer_due_at as Date).toISOString() : null,
        qty: row.qty as number,
        total: row.total as number,
        balanceDue: row.balance_due as number,
        statusSince: row.status_since ? (row.status_since as Date).toISOString() : null,
        statusSinceExact: row.status_since_exact as boolean,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "pipeline report failed");
    res.status(500).json({ error: "Pipeline report failed" });
  }
});

export default router;