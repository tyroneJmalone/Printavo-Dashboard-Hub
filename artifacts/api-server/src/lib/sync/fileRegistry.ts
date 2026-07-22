import type { Logger } from "pino";
import { db, pvOrdersTable, pvFilesTable, type InsertPvFile } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import type { PvOrderExtrasBlob } from "@workspace/printavo";

/**
 * Backup module (B3) — file registrar.
 *
 * Extracts every mirrorable file reference from data ALREADY held on a
 * pv_orders row (no Printavo API calls):
 *   - data.publicPdf          → the order's public invoice/quote PDF
 *   - extras.productionFiles  → uploaded production files (filepicker CDN)
 *   - extras.lineItems[].mockups / extras.imprints[].mockups
 *                             → artwork mockups (filepicker CDN full image)
 * thumbnailUrl is skipped — it is a derived transform of fullImageUrl.
 * Packing slips / work orders are NOT mirrorable (401 / HTML page).
 *
 * Driven by pv_orders.files_stale (defaults true = one-time backfill;
 * re-set on order change and extras write). Re-registering the same
 * (order, kind, source_id):
 *   - with a CHANGED url  → reset the row to pending (new bytes to fetch)
 *   - public_pdf always   → reset to pending (same URL, bytes change when
 *                           the order is edited)
 *   - otherwise           → leave the row (and its mirrored object) alone.
 * Rows are never deleted when a file disappears from the order — this is
 * a backup; deletion is a non-goal.
 */

export interface FileRef {
  sourceKind: "public_pdf" | "mockup" | "production_file";
  sourceId: string;
  sourceUrl: string;
  fileName: string | null;
  mimeType: string | null;
}

/** Pure extraction over the raw jsonb blobs. */
export function extractFileRefs(
  data: unknown,
  extras: PvOrderExtrasBlob | null,
): FileRef[] {
  const refs = new Map<string, FileRef>();
  const add = (ref: FileRef) => {
    refs.set(`${ref.sourceKind}:${ref.sourceId}`, ref);
  };

  const publicPdf =
    data && typeof data === "object"
      ? (data as { publicPdf?: unknown }).publicPdf
      : null;
  if (typeof publicPdf === "string" && publicPdf.startsWith("http")) {
    add({
      sourceKind: "public_pdf",
      sourceId: "pdf",
      sourceUrl: publicPdf,
      fileName: "order.pdf",
      mimeType: "application/pdf",
    });
  }

  if (extras) {
    for (const pf of extras.productionFiles ?? []) {
      if (!pf?.id || typeof pf.fileUrl !== "string" || !pf.fileUrl.startsWith("http")) {
        continue;
      }
      add({
        sourceKind: "production_file",
        sourceId: pf.id,
        sourceUrl: pf.fileUrl,
        fileName: pf.name ?? null,
        mimeType: pf.mimeType ?? null,
      });
    }
    const mockupLists = [
      ...(extras.lineItems ?? []).map((li) => li?.mockups ?? []),
      ...(extras.imprints ?? []).map((imp) => imp?.mockups ?? []),
    ];
    for (const mockups of mockupLists) {
      for (const m of mockups) {
        if (!m?.id || typeof m.fullImageUrl !== "string" || !m.fullImageUrl.startsWith("http")) {
          continue;
        }
        add({
          sourceKind: "mockup",
          sourceId: m.id,
          sourceUrl: m.fullImageUrl,
          fileName: null,
          mimeType: m.mimeType ?? null,
        });
      }
    }
  }

  return [...refs.values()];
}

const requeue = sql`(${pvFilesTable.sourceUrl} IS DISTINCT FROM excluded.source_url OR excluded.source_kind = 'public_pdf')`;

async function upsertRefs(
  orderPrintavoId: string,
  orderVisualId: number,
  refs: FileRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const rows: InsertPvFile[] = refs.map((r) => ({
    orderPrintavoId,
    orderVisualId,
    sourceKind: r.sourceKind,
    sourceId: r.sourceId,
    sourceUrl: r.sourceUrl,
    fileName: r.fileName,
    mimeType: r.mimeType,
  }));
  await db
    .insert(pvFilesTable)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        pvFilesTable.orderPrintavoId,
        pvFilesTable.sourceKind,
        pvFilesTable.sourceId,
      ],
      set: {
        sourceUrl: sql`excluded.source_url`,
        fileName: sql`coalesce(excluded.file_name, ${pvFilesTable.fileName})`,
        mimeType: sql`coalesce(excluded.mime_type, ${pvFilesTable.mimeType})`,
        status: sql`CASE WHEN ${requeue} THEN 'pending' ELSE ${pvFilesTable.status} END`,
        attempts: sql`CASE WHEN ${requeue} THEN 0 ELSE ${pvFilesTable.attempts} END`,
        attemptedAt: sql`CASE WHEN ${requeue} THEN NULL ELSE ${pvFilesTable.attemptedAt} END`,
        lastError: sql`CASE WHEN ${requeue} THEN NULL ELSE ${pvFilesTable.lastError} END`,
      },
    });
}

export interface RegistrarAgg {
  orders: number;
  filesRegistered: number;
}

/**
 * Scan up to `orderLimit` orders with files_stale=true (newest first),
 * register their file refs, and clear the flag.
 */
export async function runFileRegistrar(
  orderLimit: number,
  logger: Logger,
): Promise<RegistrarAgg> {
  const agg: RegistrarAgg = { orders: 0, filesRegistered: 0 };
  const orders = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      visualId: pvOrdersTable.visualId,
      data: pvOrdersTable.data,
      extras: pvOrdersTable.extras,
    })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.filesStale, true))
    .orderBy(desc(pvOrdersTable.visualId))
    .limit(orderLimit);

  for (const order of orders) {
    const refs = extractFileRefs(
      order.data,
      (order.extras as PvOrderExtrasBlob | null) ?? null,
    );
    await upsertRefs(order.printavoId, order.visualId, refs);
    await db
      .update(pvOrdersTable)
      .set({ filesStale: false })
      .where(eq(pvOrdersTable.printavoId, order.printavoId));
    agg.orders += 1;
    agg.filesRegistered += refs.length;
  }

  if (agg.orders > 0) {
    logger.info({ agg }, "File registrar cycle complete");
  }
  return agg;
}
