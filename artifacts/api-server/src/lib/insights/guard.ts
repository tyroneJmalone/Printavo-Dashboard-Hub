import { pool } from "@workspace/db";
import type pino from "pino";

/**
 * Guarded SQL execution for the Ask AI insights feature.
 *
 * Defense in depth — every AI-generated (or preset-stored) query passes:
 *   1. validateSql(): single SELECT/WITH statement, no semicolons, keyword
 *      denylist (DML/DDL, superuser escapes like set_config/pg_read_file,
 *      catalog snooping).
 *   2. DB-level: runs as NOLOGIN role `insights_ro` (SELECT granted only on
 *      the whitelisted tables below) inside a READ ONLY transaction with a
 *      5s statement_timeout and a hard row cap.
 *
 * Hub DB ONLY (pool = DATABASE_URL). The live moMINTum / MintBucks prod DBs
 * use separate connection strings and are unreachable from this module.
 */

/** Tables the AI may query. Grants are re-applied at every boot. */
export const INSIGHTS_TABLES = [
  "pv_orders",
  "pv_customers",
  "pv_contacts",
  "pv_statuses",
  "pv_line_item_groups",
  "pv_line_items",
  "pv_imprints",
  "pv_payments",
  "pv_payment_requests",
  "pv_inquiries",
  "pv_merch_stores",
  "pv_merch_orders",
  "pv_threads",
  "pv_messages",
  "change_events",
  "customer_categories",
  "customer_meta",
  "sync_runs",
  "chipply_stores",
  "chipply_store_styles",
] as const;

export const ROW_CAP = 500;

export class InsightsSqlError extends Error {}

const DENY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|comment|vacuum|reindex|cluster|refresh|listen|notify|prepare|deallocate|execute|call|copy|checkpoint|discard|lock|reset|set|do)\b/i,
    label: "write/DDL keywords",
  },
  { re: /\binto\b/i, label: "SELECT INTO" },
  {
    re: /\b(set_config|current_setting|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|lo_import|lo_export|lo_read|lo_get|dblink|pg_logical_slot_get_changes)\s*\(/i,
    label: "system functions",
  },
  {
    re: /\b(pg_catalog|information_schema|pg_shadow|pg_authid|pg_roles|pg_user|pg_settings|pg_tables|pg_views|pg_class|pg_namespace|pg_proc|pg_attribute|pg_matviews|pg_indexes|pg_locks|pg_stat_\w+|pg_statio_\w+)\b/i,
    label: "system catalogs",
  },
];

/**
 * Validate an AI/preset SQL string. Returns the cleaned SQL (trailing
 * semicolon stripped) or throws InsightsSqlError with a message safe to
 * feed back to the model for a retry.
 */
export function validateSql(raw: string): string {
  const cleaned = raw.trim().replace(/;+\s*$/, "").trim();
  if (!cleaned) throw new InsightsSqlError("Empty SQL");
  if (cleaned.includes(";")) {
    throw new InsightsSqlError(
      "Multiple statements are not allowed (found a semicolon)",
    );
  }
  if (!/^(select|with)\b/i.test(cleaned)) {
    throw new InsightsSqlError(
      "Only a single SELECT (or WITH ... SELECT) statement is allowed",
    );
  }
  for (const { re, label } of DENY_PATTERNS) {
    const m = cleaned.match(re);
    if (m) {
      throw new InsightsSqlError(
        `Disallowed SQL (${label}): "${m[0]}" is not permitted`,
      );
    }
  }
  return cleaned;
}

export interface GuardedQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

function serializeValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return "<binary>";
  return v;
}

/**
 * Execute validated SQL under the full guardrail stack. Throws
 * InsightsSqlError for validation failures and surfaces Postgres errors
 * (message only) for the retry loop.
 */
export async function runGuardedQuery(
  rawSql: string,
): Promise<GuardedQueryResult> {
  const sqlText = validateSql(rawSql);
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL ROLE insights_ro");
    await client.query(`SET LOCAL statement_timeout = '5s'`);
    const wrapped = `SELECT * FROM (\n${sqlText}\n) AS insights_q LIMIT ${ROW_CAP + 1}`;
    const result = await client.query({ text: wrapped, rowMode: "array" });
    const truncated = result.rows.length > ROW_CAP;
    const rows = (truncated ? result.rows.slice(0, ROW_CAP) : result.rows).map(
      (row: unknown[]) => row.map(serializeValue),
    );
    return {
      columns: result.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be dead; release() below handles it
    }
    client.release();
  }
}

/**
 * Idempotent boot setup: create the NOLOGIN insights_ro role and (re-)grant
 * SELECT on the whitelisted tables — re-run every boot so newly whitelisted
 * tables get picked up. NOTE: must also run in prod at next deploy (role +
 * grants are per-database) — happens automatically since this runs at boot.
 */
export async function ensureInsightsRole(logger: pino.Logger): Promise<void> {
  await pool.query(
    `DO $$ BEGIN CREATE ROLE insights_ro NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  );
  await pool.query(`GRANT USAGE ON SCHEMA public TO insights_ro`);
  for (const table of INSIGHTS_TABLES) {
    try {
      await pool.query(`GRANT SELECT ON TABLE public."${table}" TO insights_ro`);
    } catch (err) {
      logger.warn({ err, table }, "insights grant failed (table missing?)");
    }
  }
  logger.info(
    { tables: INSIGHTS_TABLES.length },
    "insights_ro role ready (read-only grants applied)",
  );
}
