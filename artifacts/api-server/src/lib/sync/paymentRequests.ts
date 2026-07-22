import type { Logger } from "pino";
import { db, pvPaymentRequestsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  paymentRequestsPageQuery,
  PAYMENT_REQUESTS_PAGE_SIZE,
  PrintavoApiError,
  type Connection,
} from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { contentHashOf, moneyStr, normalizeTimestamps } from "./differ";

interface PaymentRequestNode {
  id: string;
  visualId?: number | string | null;
  status?: string | null;
  amount?: number | null;
  [key: string]: unknown;
}

interface PaymentRequestsResponse {
  paymentRequests: Connection<PaymentRequestNode>;
}

export interface PaymentRequestsAgg {
  seen: number;
  written: number;
  unchanged: number;
  pages: number;
  stoppedEarly: boolean;
  degradedPages: number;
}

/**
 * Printavo declares PaymentRequest.requestedBy non-nullable, but it CAN
 * be null in practice (requesting user deleted). Unlike order extras,
 * the ENTIRE response data nulls out (verified live — no partial data
 * to salvage), so the only recovery is re-fetching the poisoned page
 * without the field.
 */
function isNonNullableFieldBug(err: unknown): boolean {
  if (!(err instanceof PrintavoApiError)) return false;
  const errors = err.graphqlErrors as Array<{ message?: string }> | undefined;
  if (!errors?.length) return false;
  return errors.every(
    (e) =>
      typeof e?.message === "string" &&
      e.message.startsWith("Cannot return null for non-nullable field"),
  );
}

/**
 * Backup module (B4b): crawl paymentRequests (newest-first, raw blob
 * incl. inline requestedDetails + payments) into pv_payment_requests.
 * With `stopOnUnchangedPage`, stops once a FULL page comes back
 * entirely hash-unchanged (payments-crawl pattern); the daily full
 * sweep catches edits deeper in the list.
 */
export async function crawlPaymentRequests(
  options: { stopOnUnchangedPage: boolean; logger: Logger },
): Promise<PaymentRequestsAgg> {
  const client = getPrintavoClient();
  const agg: PaymentRequestsAgg = {
    seen: 0,
    written: 0,
    unchanged: 0,
    pages: 0,
    stoppedEarly: false,
    degradedPages: 0,
  };

  let cursor: string | null = null;
  for (;;) {
    let data: PaymentRequestsResponse;
    try {
      data = await client.query<PaymentRequestsResponse>(
        paymentRequestsPageQuery(cursor),
      );
    } catch (err) {
      if (!isNonNullableFieldBug(err)) throw err;
      // Poisoned page (deleted requestedBy user) — recapture it
      // without the field so the rest of the records aren't lost.
      options.logger.warn(
        { cursor, err: (err as Error).message },
        "Payment requests page failed on requestedBy — retrying without it",
      );
      data = await client.query<PaymentRequestsResponse>(
        paymentRequestsPageQuery(cursor, { omitRequestedBy: true }),
      );
      agg.degradedPages += 1;
    }
    let pageChanged = false;
    for (const rawNode of data.paymentRequests.nodes) {
      const node = normalizeTimestamps(rawNode);
      const hash = contentHashOf(node);
      agg.seen += 1;

      const [existing] = await db
        .select({ contentHash: pvPaymentRequestsTable.contentHash })
        .from(pvPaymentRequestsTable)
        .where(eq(pvPaymentRequestsTable.printavoId, node.id))
        .limit(1);

      if (existing && existing.contentHash === hash) {
        await db
          .update(pvPaymentRequestsTable)
          .set({ syncedAt: new Date() })
          .where(eq(pvPaymentRequestsTable.printavoId, node.id));
        agg.unchanged += 1;
        continue;
      }

      const row = {
        printavoId: node.id,
        visualId: node.visualId != null ? String(node.visualId) : null,
        status: node.status ?? null,
        amount: moneyStr(node.amount),
        data: node,
        contentHash: hash,
        syncedAt: new Date(),
      };
      await db
        .insert(pvPaymentRequestsTable)
        .values(row)
        .onConflictDoUpdate({
          target: pvPaymentRequestsTable.printavoId,
          set: {
            visualId: row.visualId,
            status: row.status,
            amount: row.amount,
            data: row.data,
            contentHash: row.contentHash,
            syncedAt: row.syncedAt,
          },
        });
      agg.written += 1;
      pageChanged = true;
    }
    agg.pages += 1;
    if (
      options.stopOnUnchangedPage &&
      !pageChanged &&
      data.paymentRequests.nodes.length >= PAYMENT_REQUESTS_PAGE_SIZE
    ) {
      agg.stoppedEarly = true;
      break;
    }
    if (!data.paymentRequests.pageInfo.hasNextPage) break;
    cursor = data.paymentRequests.pageInfo.endCursor;
  }

  options.logger.info({ agg }, "Payment requests crawl complete");
  return agg;
}
