import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

/**
 * Sales pipeline — quotes bucketed into stages by status-name keywords,
 * plus recently created invoices in "won"/"done" statuses (in Printavo a
 * winning quote BECOMES an invoice, so the tail of the funnel lives on the
 * invoice side; the wonDays window keeps those columns meaning "recently
 * won", not all of history).
 *
 * Matching is whitespace-normalized and keyword-based (never status ids —
 * see .agents/memory/printavo-status-name-matching.md). Precedence handles
 * real overlaps in the status catalog:
 *  - contract dead/archive wins over plain dead/archive (Tyler wants broker
 *    quotes reported separately);
 *  - nurturing before art ("NURTURING- Needs; …, Art, Sponsors" contains
 *    "Art");
 *  - art before done ("DIGITIZING COMPLETE - seps.io" is still art workflow);
 *  - "art" matches on a word BOUNDARY (\yart) so "PARTIAL" doesn't hit it.
 * "MERCH STORE SOURCE (don't change)" template quotes are excluded entirely.
 *
 * Time-in-status comes from change_events (tracking began 2026-07-08).
 * Orders with no observed status change fall back to first_seen_at with
 * statusSinceExact=false ("at least this long"), unless the order was
 * created after tracking began — then created-at is exact.
 */

const router: IRouter = Router();

export const PIPELINE_STAGES: { id: string; label: string }[] = [
  { id: "quote", label: "Quote" },
  { id: "quote_sent", label: "Quote Sent" },
  { id: "follow_up_1", label: "Follow Up 1" },
  { id: "follow_up_2", label: "Follow Up 2" },
  { id: "nurturing", label: "Nurturing" },
  { id: "art", label: "Art" },
  { id: "other", label: "Other" },
  { id: "won", label: "Won" },
  { id: "done", label: "Done" },
  { id: "dead", label: "Dead" },
  { id: "contract_dead_archive", label: "Contract Dead/Archive" },
  { id: "archive", label: "Archive/Dup/Ref" },
];

const STAGE_IDS = PIPELINE_STAGES.map((s) => s.id);

/** Stages shown when no explicit stage is selected — the working pipeline. */
const ACTIVE_STAGES = [
  "quote",
  "quote_sent",
  "follow_up_1",
  "follow_up_2",
  "nurturing",
  "art",
  "other",
];

/** Whitespace-collapsed lowercase status name (statuses carry stray double spaces). */
const NORM_SQL = `lower(regexp_replace(coalesce(o.status_name, ''), '\\s+', ' ', 'g'))`;

/** Keyword → stage mapping. ORDER MATTERS — see module docblock. */
const STAGE_CASE_SQL = `CASE
  WHEN n.norm LIKE '%contract%' AND (n.norm LIKE '%dead%' OR n.norm LIKE '%archive%')
    THEN 'contract_dead_archive'
  WHEN n.norm LIKE '%dead%' THEN 'dead'
  WHEN n.norm LIKE '%archive%' OR n.norm LIKE '%duplicat%' OR n.norm LIKE '%reference%'
    THEN 'archive'
  WHEN n.norm LIKE '%nurtur%' THEN 'nurturing'
  WHEN n.norm ~ '\\yart' OR n.norm LIKE '%proof%' OR n.norm LIKE '%digitiz%'
    OR n.norm LIKE '%separat%' OR n.norm LIKE '%png%' OR n.norm LIKE '%revision%'
    THEN 'art'
  WHEN n.norm LIKE '%complete%' THEN 'done'
  WHEN n.norm LIKE '%waiting 4 blanks%' OR n.norm LIKE '%ready to go%'
    OR n.norm LIKE '%need to order%' OR n.norm LIKE '%need 2 order%'
    THEN 'won'
  WHEN n.norm LIKE '%follow up 2%' THEN 'follow_up_2'
  WHEN n.norm LIKE '%follow up 1%' THEN 'follow_up_1'
  WHEN n.norm LIKE '%quote%' AND n.norm LIKE '%sent%' THEN 'quote_sent'
  WHEN n.norm LIKE '%quote%' THEN 'quote'
  ELSE NULL
END`;

/**
 * $1 = wonDays. Quotes keep every stage ("other" catches unmapped so nothing
 * hides); invoices only enter via won/done, and won/done is windowed for
 * BOTH types so those columns always mean "last N days".
 */
const INCLUDED_CTE = `WITH base AS (
  SELECT o.printavo_id,
         o.visual_id,
         o.order_type,
         o.status_name,
         o.nickname,
         coalesce(o.total, 0)::float8 AS total,
         o.customer_id,
         coalesce(nullif(o.customer_company, ''), o.contact_name) AS customer_name,
         o.owner_email,
         o.printavo_created_at,
         o.first_seen_at,
         coalesce(nullif(o.data->>'totalQuantity', '')::int, 0) AS qty,
         CASE WHEN o.order_type = 'quote'
              THEN coalesce(${STAGE_CASE_SQL}, 'other')
              ELSE ${STAGE_CASE_SQL}
         END AS stage_id
    FROM pv_orders o
    CROSS JOIN LATERAL (SELECT ${NORM_SQL} AS norm) n
   WHERE n.norm NOT LIKE '%merch store source%'
), included AS (
  SELECT * FROM base
   WHERE stage_id IS NOT NULL
     AND (
       (order_type = 'quote' AND stage_id NOT IN ('won', 'done'))
       OR (stage_id IN ('won', 'done')
           AND printavo_created_at >= now() - make_interval(days => $1::int))
     )
)`;

function intParam(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

router.get("/pipeline", (req, res) => {
  (async () => {
    const wonDays = intParam(req.query.wonDays, 90, 7, 365);
    const limit = intParam(req.query.limit, 200, 1, 500);
    const offset = intParam(req.query.offset, 0, 0, 1_000_000);
    const owner =
      typeof req.query.owner === "string" && req.query.owner.trim() !== ""
        ? req.query.owner.trim().toLowerCase()
        : null;
    const stageRaw =
      typeof req.query.stage === "string" ? req.query.stage : "active";
    if (stageRaw !== "active" && !STAGE_IDS.includes(stageRaw)) {
      res.status(400).json({ error: `Unknown stage: ${stageRaw}` });
      return;
    }
    const rowStages = stageRaw === "active" ? ACTIVE_STAGES : [stageRaw];

    const ownersQ = pool.query(
      `${INCLUDED_CTE}
       SELECT owner_email, count(*)::int AS count
         FROM included
        WHERE owner_email IS NOT NULL
        GROUP BY owner_email
        ORDER BY count DESC, owner_email`,
      [wonDays],
    );

    const stagesQ = pool.query(
      `${INCLUDED_CTE}
       SELECT stage_id, count(*)::int AS count, coalesce(sum(total), 0)::float8 AS amount
         FROM included
        WHERE ($2::text IS NULL OR lower(coalesce(owner_email, '')) = $2)
        GROUP BY stage_id`,
      [wonDays, owner],
    );

    const rowsQ = pool.query(
      `${INCLUDED_CTE}
       SELECT i.printavo_id,
              i.visual_id,
              i.order_type,
              i.stage_id,
              i.status_name,
              i.nickname,
              i.customer_id,
              i.customer_name,
              i.owner_email,
              i.printavo_created_at,
              i.qty,
              i.total,
              coalesce(
                ev.occurred_at,
                CASE WHEN i.printavo_created_at >= i.first_seen_at - interval '2 days'
                     THEN i.printavo_created_at
                     ELSE i.first_seen_at
                END
              ) AS status_since,
              (ev.occurred_at IS NOT NULL
               OR i.printavo_created_at >= i.first_seen_at - interval '2 days'
              ) AS status_since_exact,
              count(*) OVER ()::int AS total_rows
         FROM included i
         LEFT JOIN LATERAL (
           SELECT ce.occurred_at
             FROM change_events ce
            WHERE ce.entity_type = 'order'
              AND ce.field = 'status'
              AND ce.entity_id = i.printavo_id
            ORDER BY ce.occurred_at DESC
            LIMIT 1
         ) ev ON true
        WHERE i.stage_id = ANY($2::text[])
          AND ($3::text IS NULL OR lower(coalesce(i.owner_email, '')) = $3)
        ORDER BY array_position($4::text[], i.stage_id),
                 status_since ASC NULLS LAST,
                 i.visual_id
        LIMIT $5 OFFSET $6`,
      [wonDays, rowStages, owner, STAGE_IDS, limit, offset],
    );

    const [ownersR, stagesR, rowsR] = await Promise.all([
      ownersQ,
      stagesQ,
      rowsQ,
    ]);

    const stageCounts = new Map<string, { count: number; amount: number }>(
      stagesR.rows.map((r) => [
        r.stage_id as string,
        { count: r.count as number, amount: r.amount as number },
      ]),
    );

    res.json({
      stage: stageRaw,
      wonDays,
      owners: ownersR.rows.map((r) => ({
        email: r.owner_email as string,
        count: r.count as number,
      })),
      stages: PIPELINE_STAGES.map((s) => ({
        id: s.id,
        label: s.label,
        count: stageCounts.get(s.id)?.count ?? 0,
        amount: stageCounts.get(s.id)?.amount ?? 0,
      })),
      total: (rowsR.rows[0]?.total_rows as number) ?? 0,
      limit,
      offset,
      rows: rowsR.rows.map((r) => ({
        id: r.printavo_id as string,
        visualId: r.visual_id as number,
        orderType: r.order_type as string,
        stageId: r.stage_id as string,
        statusName: r.status_name as string,
        nickname: (r.nickname as string | null) ?? null,
        customerId: (r.customer_id as string | null) ?? null,
        customerName: (r.customer_name as string | null) ?? null,
        ownerEmail: (r.owner_email as string | null) ?? null,
        createdAt: r.printavo_created_at
          ? (r.printavo_created_at as Date).toISOString()
          : null,
        qty: r.qty as number,
        total: r.total as number,
        statusSince: r.status_since
          ? (r.status_since as Date).toISOString()
          : null,
        statusSinceExact: r.status_since_exact as boolean,
      })),
    });
  })().catch((err) => {
    req.log.error({ err }, "pipeline report failed");
    res.status(500).json({ error: "Pipeline report failed" });
  });
});

export default router;
