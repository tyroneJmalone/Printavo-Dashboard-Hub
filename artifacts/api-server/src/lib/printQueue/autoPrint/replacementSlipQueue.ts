import { db, pqPrintJobsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export async function claimReplacementSlips(runId: string, printerId: string, printerName: string | null) {
  // A single atomic state transition wins across processes. All non-queued
  // states (including crashes, failures and unknown acceptance) block replay.
  return db.update(pqPrintJobsTable).set({ status: "pending", runId, printerId, printerName })
    .where(and(eq(pqPrintJobsTable.docType, "replacement_slip"), eq(pqPrintJobsTable.status, "queued")))
    .returning();
}
