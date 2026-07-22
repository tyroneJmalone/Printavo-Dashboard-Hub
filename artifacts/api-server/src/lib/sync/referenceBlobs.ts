import type { Logger } from "pino";
import { db, pvReferenceBlobsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  accountReferencePageQuery,
  referenceFieldFor,
  REFERENCE_KINDS,
  type ReferenceKind,
  type Connection,
} from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { contentHashOf, normalizeTimestamps } from "./differ";

interface ReferenceNode {
  id: string;
  [key: string]: unknown;
}

export interface ReferenceBlobsAgg {
  seen: number;
  written: number;
  unchanged: number;
}

/**
 * Backup module (B4a): full re-crawl of the account-level reference
 * connections into pv_reference_blobs, hash-guarded. Runs inside the
 * existing daily reference sweep. Rows for entities deleted in
 * Printavo are kept (backup semantics) — their synced_at just stops
 * advancing.
 */
export async function refreshReferenceBlobs(
  logger: Logger,
): Promise<ReferenceBlobsAgg> {
  const client = getPrintavoClient();
  const agg: ReferenceBlobsAgg = { seen: 0, written: 0, unchanged: 0 };

  for (const kind of REFERENCE_KINDS) {
    const field = referenceFieldFor(kind);
    let cursor: string | null = null;
    for (;;) {
      const data: { account: Record<string, Connection<ReferenceNode>> } =
        await client.query<{
          account: Record<string, Connection<ReferenceNode>>;
        }>(accountReferencePageQuery(kind, cursor));
      const conn = data.account?.[field];
      if (!conn) {
        throw new Error(`Reference crawl: missing account.${field} in response`);
      }
      for (const rawNode of conn.nodes) {
        await upsertReferenceBlob(kind, rawNode, agg);
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  logger.info({ agg }, "Reference blobs refresh complete");
  return agg;
}

async function upsertReferenceBlob(
  kind: ReferenceKind,
  rawNode: ReferenceNode,
  agg: ReferenceBlobsAgg,
): Promise<void> {
  const node = normalizeTimestamps(rawNode);
  const hash = contentHashOf(node);
  agg.seen += 1;

  const [existing] = await db
    .select({ contentHash: pvReferenceBlobsTable.contentHash })
    .from(pvReferenceBlobsTable)
    .where(
      and(
        eq(pvReferenceBlobsTable.kind, kind),
        eq(pvReferenceBlobsTable.printavoId, node.id),
      ),
    )
    .limit(1);

  if (existing && existing.contentHash === hash) {
    await db
      .update(pvReferenceBlobsTable)
      .set({ syncedAt: new Date() })
      .where(
        and(
          eq(pvReferenceBlobsTable.kind, kind),
          eq(pvReferenceBlobsTable.printavoId, node.id),
        ),
      );
    agg.unchanged += 1;
    return;
  }

  await db
    .insert(pvReferenceBlobsTable)
    .values({
      kind,
      printavoId: node.id,
      data: node,
      contentHash: hash,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pvReferenceBlobsTable.kind, pvReferenceBlobsTable.printavoId],
      set: { data: node, contentHash: hash, syncedAt: new Date() },
    });
  agg.written += 1;
}
