import { Router, type IRouter } from "express";
import { ZipArchive } from "archiver";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { pool } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireStaff";
import { latestRun, listWatermarks } from "../lib/sync/state";
import { schedulerInfo } from "../lib/sync/scheduler";
import type { SyncRun } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Backup export/status routes.
 *
 * The export is a full portable snapshot of the Printavo backup: one
 * NDJSON file per table (one JSON object per line, straight from
 * `row_to_json` — exact DB column names and values) zipped into a
 * single download. Mirrored binary files stay in object storage;
 * pv_files.ndjson is the manifest of them.
 *
 * Tables are streamed sequentially with keyset pagination (never
 * OFFSET) so memory stays flat and the 5-minute sync polls are not
 * disturbed. Largest tables go first so a failure surfaces early.
 */
interface ExportTable {
  /** SQL table name (hardcoded config — never user input). */
  table: string;
  /** Single-column PK used for keyset paging. */
  pk: string;
}

const EXPORT_TABLES: ExportTable[] = [
  { table: "pv_orders", pk: "printavo_id" },
  { table: "pv_line_items", pk: "printavo_id" },
  { table: "pv_merch_orders", pk: "printavo_id" },
  { table: "pv_messages", pk: "printavo_id" },
  { table: "pv_payments", pk: "printavo_id" },
  { table: "pv_imprints", pk: "printavo_id" },
  { table: "pv_threads", pk: "printavo_id" },
  { table: "pv_line_item_groups", pk: "printavo_id" },
  { table: "pv_order_line_item_snapshots", pk: "id" },
  { table: "pv_files", pk: "id" },
  { table: "pv_contacts", pk: "printavo_id" },
  { table: "pv_customers", pk: "printavo_id" },
  { table: "pv_payment_requests", pk: "printavo_id" },
  { table: "pv_inquiries", pk: "printavo_id" },
  { table: "pv_merch_stores", pk: "printavo_id" },
  { table: "pv_statuses", pk: "printavo_id" },
  { table: "pv_reference_blobs", pk: "id" },
  { table: "change_events", pk: "id" },
  { table: "entity_watermarks", pk: "entity" },
];

const EXPORT_PAGE_SIZE = 1000;

/** Tables surfaced on the status dashboard (superset incl. metadata). */
const STATUS_TABLES: { table: string; syncedAtCol: string | null }[] = [
  { table: "pv_orders", syncedAtCol: "synced_at" },
  { table: "pv_line_items", syncedAtCol: "synced_at" },
  { table: "pv_line_item_groups", syncedAtCol: "synced_at" },
  { table: "pv_order_line_item_snapshots", syncedAtCol: "observed_at" },
  { table: "pv_imprints", syncedAtCol: "synced_at" },
  { table: "pv_customers", syncedAtCol: "synced_at" },
  { table: "pv_contacts", syncedAtCol: "synced_at" },
  { table: "pv_payments", syncedAtCol: "synced_at" },
  { table: "pv_statuses", syncedAtCol: "synced_at" },
  { table: "pv_threads", syncedAtCol: "synced_at" },
  { table: "pv_messages", syncedAtCol: "synced_at" },
  { table: "pv_inquiries", syncedAtCol: "synced_at" },
  { table: "pv_payment_requests", syncedAtCol: "synced_at" },
  { table: "pv_merch_stores", syncedAtCol: "synced_at" },
  { table: "pv_merch_orders", syncedAtCol: "synced_at" },
  { table: "pv_reference_blobs", syncedAtCol: "synced_at" },
  { table: "pv_files", syncedAtCol: "mirrored_at" },
  { table: "change_events", syncedAtCol: "occurred_at" },
];

function runInfo(run: SyncRun | null) {
  if (!run) return null;
  return {
    id: run.id,
    runType: run.runType,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    stats: (run.stats as Record<string, unknown> | null) ?? null,
    error: run.error ?? null,
  };
}

router.get("/backup/status", async (_req, res) => {
  try {
    const countsSql = STATUS_TABLES.map(
      ({ table, syncedAtCol }) =>
        `SELECT '${table}' AS tbl, count(*)::bigint AS rows, ${
          syncedAtCol ? `max(${syncedAtCol})` : "NULL::timestamptz"
        } AS last FROM ${table}`,
    ).join(" UNION ALL ");

    const [tables, extras, threads, files, watermarks, incremental] =
      await Promise.all([
        pool.query(countsSql),
        pool.query(
          `SELECT count(*) FILTER (WHERE extras_synced_at IS NOT NULL)::bigint AS done,
                  count(*)::bigint AS total
           FROM pv_orders`,
        ),
        pool.query(
          `SELECT count(*) FILTER (WHERE messages_stale)::bigint AS stale,
                  count(*)::bigint AS total
           FROM pv_threads`,
        ),
        pool.query(
          `SELECT status, count(*)::bigint AS count,
                  coalesce(sum(byte_size), 0)::bigint AS bytes
           FROM pv_files GROUP BY status`,
        ),
        listWatermarks(),
        latestRun("incremental"),
      ]);

    res.json({
      tables: tables.rows.map((r) => ({
        table: r.tbl as string,
        rows: Number(r.rows),
        lastActivityAt: r.last ? new Date(r.last).toISOString() : null,
      })),
      extras: {
        done: Number(extras.rows[0]?.done ?? 0),
        total: Number(extras.rows[0]?.total ?? 0),
      },
      threads: {
        messagesPending: Number(threads.rows[0]?.stale ?? 0),
        total: Number(threads.rows[0]?.total ?? 0),
      },
      files: files.rows.map((r) => ({
        status: r.status as string,
        count: Number(r.count),
        bytes: Number(r.bytes),
      })),
      watermarks: watermarks.map((w) => ({
        entity: w.entity,
        watermark: w.watermark.toISOString(),
      })),
      lastIncremental: runInfo(incremental),
      scheduler: schedulerInfo(),
      exportInFlight,
    });
  } catch (err) {
    logger.error({ err }, "backup status failed");
    res.status(500).json({ error: "Failed to load backup status" });
  }
});

let exportInFlight = false;

router.get("/backup/export", requireAdmin, async (req, res) => {
  if (exportInFlight) {
    res.status(409).json({
      error: "An export is already in progress — try again in a few minutes.",
    });
    return;
  }
  exportInFlight = true;

  // If the client disconnects mid-download, archiver stops consuming the
  // current PassThrough and its 'drain' never fires — so every drain wait
  // must race against this promise or the handler hangs forever with
  // exportInFlight stuck true (409s until restart).
  let clientGone = false;
  const responseClosed = new Promise<void>((resolve) => {
    res.on("close", () => {
      clientGone = true;
      resolve();
    });
  });

  const startedAt = Date.now();
  try {
    // Row counts up front for the manifest (cheap relative to export).
    const counts: Record<string, number> = {};
    for (const { table } of EXPORT_TABLES) {
      const r = await pool.query(`SELECT count(*)::bigint AS n FROM ${table}`);
      counts[table] = Number(r.rows[0]?.n ?? 0);
    }

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="printavo-backup-${today}.zip"`,
    );

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("warning", (err: Error) => logger.warn({ err }, "export zip warning"));
    // Errors propagate through the pipe; also fail loudly in logs.
    archive.on("error", (err: Error) => {
      logger.error({ err }, "export zip error");
      res.destroy(err);
    });
    archive.pipe(res);

    archive.append(
      JSON.stringify(
        {
          formatVersion: 1,
          generatedAt: new Date().toISOString(),
          source: "Printavo Hub backup (pv_* raw snapshots + Hub change log)",
          format:
            "One .ndjson file per table; one JSON object per line with exact database column names. Raw Printavo API payloads are in each row's data/extras fields.",
          mirroredFiles:
            "Binary files (PDFs, mockups, production files) live in object storage; pv_files.ndjson lists every file with its storage path (object_path) and original source URL.",
          tables: EXPORT_TABLES.map(({ table }) => ({
            name: table,
            rows: counts[table],
          })),
        },
        null,
        2,
      ),
      { name: "manifest.json" },
    );

    for (const { table, pk } of EXPORT_TABLES) {
      if (clientGone) break;
      const entry = new PassThrough();
      archive.append(entry, { name: `${table}.ndjson` });

      let lastKey: unknown = null;
      for (;;) {
        if (clientGone) break;
        const page = lastKey === null
          ? await pool.query(
              `SELECT row_to_json(t)::text AS j, ${pk} AS k FROM ${table} t ORDER BY ${pk} LIMIT ${EXPORT_PAGE_SIZE}`,
            )
          : await pool.query(
              `SELECT row_to_json(t)::text AS j, ${pk} AS k FROM ${table} t WHERE ${pk} > $1 ORDER BY ${pk} LIMIT ${EXPORT_PAGE_SIZE}`,
              [lastKey],
            );
        if (page.rows.length === 0) break;
        const chunk = page.rows.map((r) => r.j as string).join("\n") + "\n";
        if (!entry.write(chunk)) {
          await Promise.race([once(entry, "drain"), responseClosed]);
          if (clientGone) break;
        }
        lastKey = page.rows[page.rows.length - 1]!.k;
        if (page.rows.length < EXPORT_PAGE_SIZE) break;
      }
      entry.end();
    }

    if (clientGone) {
      archive.abort();
      logger.warn("backup export aborted — client disconnected");
      return;
    }

    await archive.finalize();
    logger.info(
      { ms: Date.now() - startedAt, tables: EXPORT_TABLES.length },
      "backup export streamed",
    );
  } catch (err) {
    logger.error({ err }, "backup export failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed" });
    } else {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    exportInFlight = false;
  }
});

export default router;
