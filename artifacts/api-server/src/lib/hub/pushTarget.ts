/**
 * Notes + PNG push target resolution for quotes created by a calculator
 * handoff that the pv_orders mirror has not synced yet.
 *
 * Only an identity Hub itself confirmed (an `ok` new-quote handoff row with
 * this exact result id + visual number) is accepted, and it is re-verified
 * with a live read-only Printavo query before any write.
 */
import { and, eq } from "drizzle-orm";
import { db, hubCalcHandoffsTable } from "@workspace/db";
import { quoteByIdQuery } from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";

export interface ConfirmedQuoteTarget {
  visualId: number;
  orderType: "quote";
}

export function matchesConfirmedQuote(
  row: { status: string; targetKind: string; resultOrderId: string | null; resultVisualId: number | null } | undefined,
  liveVisualId: number | null,
  orderId: string,
  visualId: number,
): boolean {
  return (
    !!row &&
    row.status === "ok" &&
    row.targetKind === "new_quote" &&
    row.resultOrderId === orderId &&
    row.resultVisualId === visualId &&
    liveVisualId === visualId
  );
}

export async function resolveConfirmedHandoffQuote(
  orderId: string,
  visualId: number,
): Promise<ConfirmedQuoteTarget | null> {
  const [row] = await db
    .select({
      status: hubCalcHandoffsTable.status,
      targetKind: hubCalcHandoffsTable.targetKind,
      resultOrderId: hubCalcHandoffsTable.resultOrderId,
      resultVisualId: hubCalcHandoffsTable.resultVisualId,
    })
    .from(hubCalcHandoffsTable)
    .where(
      and(
        eq(hubCalcHandoffsTable.resultOrderId, orderId),
        eq(hubCalcHandoffsTable.status, "ok"),
        eq(hubCalcHandoffsTable.targetKind, "new_quote"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const live = await getPrintavoClient().query<{ quote: { id: string; visualId: number | string } | null }>(
    quoteByIdQuery(orderId),
  );
  const liveVisualId = live.quote ? Number(live.quote.visualId) : null;
  return matchesConfirmedQuote(row, liveVisualId, orderId, visualId) ? { visualId, orderType: "quote" } : null;
}
