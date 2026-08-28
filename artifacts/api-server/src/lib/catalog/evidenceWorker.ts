import { pool } from "@workspace/db";
import type { Logger } from "pino";
import { fetchAndMeasureSwatch, SWATCH_MEASUREMENT_VERSION } from "./colorMeasurement";

const BATCH_SIZE = 4;
const PERIOD_MS = 15_000;
const MAX_ATTEMPTS = 6;
let timer: NodeJS.Timeout | undefined;
let active = false;

/** Claim a tiny batch with SKIP LOCKED so multiple servers cannot measure the
 * same swatch. A claim is represented by a short retry window, not a lock
 * held while downloading untrusted vendor bytes. */
async function claim(): Promise<any[]> {
  const result = await pool.query(`
    WITH candidates AS (
      SELECT id, algorithm_version IS DISTINCT FROM $2 AS stale_algorithm FROM catalog_color_evidence
       WHERE status = 'pending'
          OR (status = 'error' AND attempts < ${MAX_ATTEMPTS} AND (retry_at IS NULL OR retry_at <= now()))
          OR (source_swatch_url IS NOT NULL AND algorithm_version IS DISTINCT FROM $2
              AND status IN ('measured','rejected','unavailable'))
       ORDER BY priority DESC, updated_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE catalog_color_evidence e SET status = 'error', retry_at = now() + interval '2 minutes',
      attempts = CASE WHEN candidates.stale_algorithm THEN 1 ELSE attempts + 1 END, updated_at = now()
     FROM candidates WHERE e.id = candidates.id
     RETURNING e.*`, [BATCH_SIZE, SWATCH_MEASUREMENT_VERSION]);
  return result.rows;
}

/** Seed only a bounded number of imported colors each tick. This is a short
 * database operation and intentionally happens before any network work. */
async function seedMissingEvidence(): Promise<void> {
  await pool.query(`
    INSERT INTO catalog_color_evidence (vendor,style_name,color_name,status,source_swatch_url)
    SELECT p.vendor,p.style_name,c.color_name,
      CASE WHEN c.swatch_image IS NULL OR btrim(c.swatch_image)='' THEN 'unavailable' ELSE 'pending' END,
      NULLIF(btrim(c.swatch_image),'')
    FROM catalog_colors c JOIN catalog_products p ON p.id=c.product_id
    LEFT JOIN catalog_color_evidence e ON e.vendor=p.vendor AND e.style_name=p.style_name AND e.color_name=c.color_name
    WHERE e.id IS NULL
    ORDER BY p.updated_at,c.color_name LIMIT $1
    ON CONFLICT (vendor,style_name,color_name) DO NOTHING`, [BATCH_SIZE]);
}

export async function processColorEvidenceBatch(log: Logger): Promise<number> {
  if (active) return 0;
  active = true;
  try {
    await seedMissingEvidence();
    const rows = await claim();
    for (const row of rows) {
      if (!row.source_swatch_url) continue;
      const measured = await fetchAndMeasureSwatch(row.source_swatch_url);
      if (measured.ok) {
        await pool.query(`UPDATE catalog_color_evidence SET status='measured', source_swatch_hash=$2,
          rgb_r=$3,rgb_g=$4,rgb_b=$5,lab_l=$6,lab_a=$7,lab_b=$8,measurement_method=$9,
          color_profile=$10,illuminant=$11,confidence=$12,quality=$13,reason=$14,
           algorithm_version=$15,priority=0,measured_at=now(),retry_at=NULL,updated_at=now() WHERE id=$1`,
          [row.id, measured.hash, ...measured.rgb, ...measured.lab, measured.method, measured.profile,
            measured.illuminant, measured.confidence, measured.quality, measured.reason, measured.algorithmVersion]);
      } else {
        const exhausted = Number(row.attempts ?? 1) >= MAX_ATTEMPTS;
        const terminal = /not allowed|no opaque|noisy|decode|dimensions|byte limit/i.test(measured.reason);
        const delay = Math.min(24 * 60, 2 ** Math.min(Number(row.attempts ?? 1), 10));
        await pool.query(`UPDATE catalog_color_evidence SET status=$2, reason=$3, algorithm_version=$4,
          retry_at=CASE WHEN $2='error' THEN now() + ($5::text || ' minutes')::interval ELSE NULL END,
           priority=CASE WHEN $2='error' THEN priority ELSE 0 END,updated_at=now() WHERE id=$1`,
          [row.id, terminal ? "rejected" : exhausted ? "unavailable" : "error", exhausted ? "Swatch measurement retry limit reached." : measured.reason, measured.algorithmVersion, delay]);
      }
    }
    return rows.length;
  } catch (err) {
    log.warn({ err }, "catalog color evidence batch failed");
    return 0;
  } finally { active = false; }
}

/** A paced worker: each tick has a hard four-record limit and never blocks a
 * catalog import. It is safe to call repeatedly during server lifecycle. */
export function startColorEvidenceWorker(log: Logger): void {
  if (timer) return;
  log.info({ periodMs: PERIOD_MS, batchSize: BATCH_SIZE }, "Catalog color evidence worker started");
  timer = setInterval(() => void processColorEvidenceBatch(log), PERIOD_MS);
  timer.unref();
  void processColorEvidenceBatch(log);
}
