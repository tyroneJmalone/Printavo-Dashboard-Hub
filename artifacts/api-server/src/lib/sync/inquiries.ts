import type { Logger } from "pino";
import { db, pvInquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { inquiriesPageQuery, type Connection } from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { contentHashOf, normalizeTimestamps } from "./differ";

interface InquiryNode {
  id: string;
  unread?: boolean | null;
  [key: string]: unknown;
}

interface InquiriesResponse {
  inquiries: Connection<InquiryNode>;
}

export interface InquiriesAgg {
  seen: number;
  written: number;
  unchanged: number;
}

/**
 * Backup module (B4b): full crawl of inquiries (website contact-form
 * leads) into pv_inquiries, hash-guarded. Tiny entity — runs daily.
 */
export async function crawlInquiries(logger: Logger): Promise<InquiriesAgg> {
  const client = getPrintavoClient();
  const agg: InquiriesAgg = { seen: 0, written: 0, unchanged: 0 };

  let cursor: string | null = null;
  for (;;) {
    const data: InquiriesResponse = await client.query<InquiriesResponse>(
      inquiriesPageQuery(cursor),
    );
    for (const rawNode of data.inquiries.nodes) {
      const node = normalizeTimestamps(rawNode);
      const hash = contentHashOf(node);
      agg.seen += 1;

      const [existing] = await db
        .select({ contentHash: pvInquiriesTable.contentHash })
        .from(pvInquiriesTable)
        .where(eq(pvInquiriesTable.printavoId, node.id))
        .limit(1);

      if (existing && existing.contentHash === hash) {
        await db
          .update(pvInquiriesTable)
          .set({ syncedAt: new Date() })
          .where(eq(pvInquiriesTable.printavoId, node.id));
        agg.unchanged += 1;
        continue;
      }

      const row = {
        printavoId: node.id,
        unread: node.unread ?? null,
        data: node,
        contentHash: hash,
        syncedAt: new Date(),
      };
      await db
        .insert(pvInquiriesTable)
        .values(row)
        .onConflictDoUpdate({
          target: pvInquiriesTable.printavoId,
          set: {
            unread: row.unread,
            data: row.data,
            contentHash: row.contentHash,
            syncedAt: row.syncedAt,
          },
        });
      agg.written += 1;
    }
    if (!data.inquiries.pageInfo.hasNextPage) break;
    cursor = data.inquiries.pageInfo.endCursor;
  }

  logger.info({ agg }, "Inquiries crawl complete");
  return agg;
}
