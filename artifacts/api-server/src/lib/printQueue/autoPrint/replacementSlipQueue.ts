import { randomUUID } from "node:crypto";
import { db, pqPrintJobsTable, pvOrdersTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PoFileDto } from "../../purchasing/poFiles";
import { replacementSlipSnapshot } from "./replacementSlip";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Called only on a fresh confirmed vendor submission, inside its PO-lock transaction.
 * No startup scan, timestamp cutoff, or historical backfill.
 */
export async function enqueueReplacementSlip(tx: Transaction, po: PoFileDto): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const lines = po.lineItems.filter(line => line.visualId === 22787);
  if (!lines.length) return;
  const ids = [...new Set(lines.flatMap(line => line.printavoOrderId ? [line.printavoOrderId] : []))];
  const orders = ids.length ? await tx.select({
    printavoId: pvOrdersTable.printavoId, visualId: pvOrdersTable.visualId, nickname: pvOrdersTable.nickname,
  }).from(pvOrdersTable).where(inArray(pvOrdersTable.printavoId, ids)) : [];
  // Invalid source snapshots still get an audit record, but never a print.
  let snapshot;
  let error: string | null = null;
  try { snapshot = replacementSlipSnapshot(po, orders); }
  catch (err) { error = err instanceof Error ? err.message : String(err); }
  await tx.insert(pqPrintJobsTable).values({
    runId: randomUUID(), docType: "replacement_slip", status: "queued",
    printavoOrderId: snapshot?.orderId ?? ids[0] ?? "unverified",
    visualId: "22787", nickname: snapshot?.nickname, hubPoId: po.id, hubPoNumber: po.poNumber,
    attemptKey: `replacement-slip:${po.id}:22787`, copies: 1,
    snapshotMetadata: snapshot ?? { po, validationError: error }, errorMessage: error,
  }).onConflictDoNothing();
}

export async function claimReplacementSlips(runId: string, printerId: string, printerName: string | null) {
  // A single atomic state transition wins across processes. All non-queued
  // states (including crashes, failures and unknown acceptance) block replay.
  return db.update(pqPrintJobsTable).set({ status: "pending", runId, printerId, printerName })
    .where(and(eq(pqPrintJobsTable.docType, "replacement_slip"), eq(pqPrintJobsTable.status, "queued")))
    .returning();
}
