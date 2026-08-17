import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

/**
 * Status activity — daily counts of orders ENTERING each status, sourced
 * from the change_events feed (tracking began 2026-07-08; occurred_at is
 * observation time, so granularity equals the sync poll interval).
 *
 * Plus a bottleneck summary per status: how many orders sit in it right
 * now and the median time they've been there (same status_since fallback
 * logic as /pipeline: last observed status change, else created/first-seen).
 *
 * Statuses are grouped by whitespace-normalized name (names carry stray
 * double spaces/emoji — never match on ids or exact strings; see
 * .agents/memory/printavo-status-name-matching.md). The most recent raw
 * spelling is used for display.
 */

const router: IRouter = Router();

/** Whitespace-collapsed lowercase name, parameterized on the source expression. */
const norm = (expr: string) => `lower(regexp_replace(coalesce(${expr}, ''), '\\s+', ' ', 'g'))`;

/** Keyword → pipeline stage (kept in sync with /pipeline's mapping). */
const stageCase = (normCol: string) => `CASE
  WHEN ${normCol} LIKE '%contract%' AND (${normCol} LIKE '%dead%' OR ${normCol} LIKE '%archive%')
    THEN 'contract_dead_archive'
  WHEN ${normCol} LIKE '%dead%' THEN 'dead'
  WHEN ${normCol} LIKE '%archive%' OR ${normCol} LIKE '%duplicat%' OR ${normCol} LIKE '%reference%'
    THEN 'archive'
  WHEN ${normCol} LIKE '%nurtur%' THEN 'nurturing'
  WHEN ${normCol} ~ '\\yart' OR ${normCol} LIKE '%proof%' OR ${normCol} LIKE '%digitiz%'
    OR ${normCol} LIKE '%separat%' OR ${normCol} LIKE '%png%' OR ${normCol} LIKE '%revision%'
    THEN 'art'
  WHEN ${normCol} LIKE '%complete%' THEN 'done'
  WHEN ${normCol} LIKE '%waiting 4 blanks%' OR ${normCol} LIKE '%ready to go%'
    OR ${normCol} LIKE '%need to order%' OR ${normCol} LIKE '%need 2 order%'
    THEN 'won'
  WHEN ${normCol} LIKE '%follow up 2%' THEN 'follow_up_2'
  WHEN ${normCol} LIKE '%follow up 1%' THEN 'follow_up_1'
  WHEN ${normCol} LIKE '%quote%' AND ${normCol} LIKE '%sent%' THEN 'quote_sent'
  WHEN ${normCol} LIKE '%quote%' THEN 'quote'
  ELSE NULL
END`;

function intParam(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

router.get("/status-activity", (req, res) => {
  (async () => {
    const days = intParam(req.query.days, 30, 1, 365);

    // Daily arrivals per normalized status, shop-local days.
    const arrivalsQ = pool.query(
      `WITH ev AS (
         SELECT ${norm(`ce.new_value #>> '{}'`)} AS norm_name,
                ce.new_value #>> '{}' AS raw_name,
                (ce.occurred_at AT TIME ZONE 'America/Chicago')::date AS day,
                ce.occurred_at
           FROM change_events ce
          WHERE ce.entity_type = 'order'
            AND ce.event_type = 'status_change'
            -- Inclusive Chicago calendar window: today plus the (N-1) prior
            -- local dates, so the grid's oldest column is a full day, not a
            -- rolling-cutoff partial.
            AND (ce.occurred_at AT TIME ZONE 'America/Chicago')::date
                >= (now() AT TIME ZONE 'America/Chicago')::date - ($1::int - 1)
       )
       SELECT norm_name,
              (array_agg(raw_name ORDER BY occurred_at DESC))[1] AS display_name,
              day::text AS day,
              count(*)::int AS count
         FROM ev
        WHERE norm_name <> ''
        GROUP BY norm_name, day
        ORDER BY norm_name, day`,
      [days],
    );

    // Current occupancy + dwell per normalized status (all non-template orders).
    const occupancyQ = pool.query(
      `WITH cur AS (
         SELECT o.status_name,
                n.norm AS norm_name,
                ${stageCase("n.norm")} AS stage_id,
                coalesce(
                  ev.occurred_at,
                  CASE WHEN o.printavo_created_at >= o.first_seen_at - interval '2 days'
                       THEN o.printavo_created_at
                       ELSE o.first_seen_at
                  END
                ) AS since,
                -- Exact when we observed the change (or the order was created
                -- after tracking began). Bulk-imported orders share one
                -- first_seen_at, which would make every median identical.
                (ev.occurred_at IS NOT NULL
                 OR o.printavo_created_at >= o.first_seen_at - interval '2 days'
                ) AS exact
           FROM pv_orders o
           CROSS JOIN LATERAL (SELECT ${norm("o.status_name")} AS norm) n
           LEFT JOIN (
             -- Latest observed status change per order, aggregated once
             -- instead of a per-row LATERAL probe over all of pv_orders.
             SELECT DISTINCT ON (ce.entity_id) ce.entity_id, ce.occurred_at
               FROM change_events ce
              WHERE ce.entity_type = 'order'
                AND ce.event_type = 'status_change'
                AND ce.field = 'status'
              ORDER BY ce.entity_id, ce.occurred_at DESC
           ) ev ON ev.entity_id = o.printavo_id
          WHERE n.norm <> ''
            AND n.norm NOT LIKE '%merch store source%'
       )
       SELECT norm_name,
              (array_agg(status_name))[1] AS display_name,
              (array_agg(stage_id))[1] AS stage_id,
              count(*)::int AS current_count,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now() - since)))
                 FILTER (WHERE exact) / 86400.0)::float8 AS median_dwell_days,
              (max(EXTRACT(EPOCH FROM (now() - since))) FILTER (WHERE exact) / 86400.0)::float8 AS max_dwell_days
         FROM cur
        GROUP BY norm_name`,
      [],
    );

    const firstTrackedQ = pool.query(
      `SELECT min(occurred_at) AS first_tracked
         FROM change_events
        WHERE entity_type = 'order' AND event_type = 'status_change'`,
    );

    const [arrivalsR, occupancyR, firstTrackedR] = await Promise.all([arrivalsQ, occupancyQ, firstTrackedQ]);

    interface Row {
      normName: string;
      displayName: string;
      stageId: string | null;
      totalArrivals: number;
      daily: { day: string; count: number }[];
      currentCount: number;
      medianDwellDays: number | null;
      maxDwellDays: number | null;
    }
    const byNorm = new Map<string, Row>();
    const rowFor = (normName: string, displayName: string): Row => {
      let r = byNorm.get(normName);
      if (!r) {
        r = {
          normName,
          displayName,
          stageId: null,
          totalArrivals: 0,
          daily: [],
          currentCount: 0,
          medianDwellDays: null,
          maxDwellDays: null,
        };
        byNorm.set(normName, r);
      }
      return r;
    };
    for (const a of arrivalsR.rows) {
      const r = rowFor(a.norm_name as string, a.display_name as string);
      r.daily.push({ day: a.day as string, count: a.count as number });
      r.totalArrivals += a.count as number;
    }
    for (const o of occupancyR.rows) {
      const r = rowFor(o.norm_name as string, o.display_name as string);
      // Prefer the current-orders spelling for display; arrivals may be stale names.
      r.displayName = (o.display_name as string) || r.displayName;
      r.stageId = (o.stage_id as string | null) ?? null;
      r.currentCount = o.current_count as number;
      r.medianDwellDays = o.median_dwell_days != null ? Number(o.median_dwell_days) : null;
      r.maxDwellDays = o.max_dwell_days != null ? Number(o.max_dwell_days) : null;
    }

    const statuses = [...byNorm.values()].sort(
      (a, b) => b.totalArrivals - a.totalArrivals || b.currentCount - a.currentCount,
    );
    const firstTracked = firstTrackedR.rows[0]?.first_tracked as Date | null;

    res.json({
      days,
      firstTrackedAt: firstTracked ? firstTracked.toISOString() : null,
      statuses: statuses.map((s) => ({
        statusName: s.displayName,
        stageId: s.stageId,
        totalArrivals: s.totalArrivals,
        daily: s.daily,
        currentCount: s.currentCount,
        medianDwellDays: s.medianDwellDays,
        maxDwellDays: s.maxDwellDays,
      })),
    });
  })().catch((err) => {
    req.log.error({ err }, "status activity report failed");
    res.status(500).json({ error: "Status activity report failed" });
  });
});

export default router;
