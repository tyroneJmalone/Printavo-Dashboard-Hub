import { db, pqPrintJobsTable as jobs, changeEventsTable, pvStatusesTable, type PqPrintJob } from "@workspace/db";
import { and, eq, or, desc, sql } from "drizzle-orm";
import type { PvOrderDetailNode } from "@workspace/printavo";
import { getAutoPrintConfig } from "./config";
import { decideReprint, observedSourceMembership, verifiedConversionOrderIds } from "./candidatePlanning";
import { retrySnapshot } from "./retryStore";
import { WorkorderSkip } from "./workorderRetry";
import { classifyDecorationLines, destinationMappingForClassification } from "../../purchasing/decorationClassifier";
import { conditionalAutoPrintDestination } from "./routing";
import { businessDaysUntilDue } from "../../purchasing/businessDays";
import { classifyAutoPrint, planMerchCategories } from "./decorationEvidence";

/** Deferred detail failures still need normal reprint eligibility, not a bypass. */
export async function prepareRetry(job: PqPrintJob, fingerprint: string,
  node: PvOrderDetailNode & { nickname?: string; customerDueAt?: string }) {
  const snapshot = retrySnapshot(job);
  const config = await getAutoPrintConfig();
  const prior = (await db.select().from(jobs).where(and(eq(jobs.docType, "workorder"), eq(jobs.status, "printed"),
    or(eq(jobs.printavoOrderId, job.printavoOrderId), eq(jobs.visualId, job.visualId!))))
    .orderBy(desc(jobs.printedAt), desc(jobs.id)).limit(1))[0] ?? null;
  if ((prior?.id ?? null) !== job.priorJobId) throw new WorkorderSkip("Prior accepted print changed; automatic retry blocked");
  let eligibilityCycle = job.eligibilityCycle;
  if (!snapshot.fingerprint && prior) {
    const events = await db.select().from(changeEventsTable).where(and(eq(changeEventsTable.entityType, "order"),
      or(eq(changeEventsTable.entityId, job.printavoOrderId), eq(changeEventsTable.visualId, Number(job.visualId)))))
      .orderBy(desc(changeEventsTable.occurredAt), desc(changeEventsTable.id));
    const converted = verifiedConversionOrderIds({ orderId: job.printavoOrderId, visualId: Number(job.visualId) }, events);
    if (prior.printavoOrderId !== job.printavoOrderId && !converted.includes(prior.printavoOrderId)) {
      throw new WorkorderSkip("Prior visual identity is not verified across conversion");
    }
    const statuses = (await db.select().from(pvStatusesTable)).map(s => ({ id: s.printavoId, name: s.name }));
    if (config.sourceStatusIds.some(id => !statuses.some(s => s.id === id))) throw new WorkorderSkip("Source status history unverifiable");
    const sourceIds = new Set(config.sourceStatusIds);
    const reentry = events.find(e => e.eventType === "status_change" && e.field === "status" &&
      (e.entityId === job.printavoOrderId || converted.includes(e.entityId)) &&
      observedSourceMembership(e.oldValue, statuses, sourceIds) === false &&
      observedSourceMembership(e.newValue, statuses, sourceIds) === true) ?? null;
    const decision = decideReprint({ prior, fingerprint, reentry });
    if (!decision.allowed) throw new WorkorderSkip(decision.reason!);
    eligibilityCycle = decision.cycle;
  }
  let targetStatusId = job.targetStatusId, targetStatusName = job.targetStatusName;
  let routingRule = snapshot.routingRule ?? null;
  if (!snapshot.fingerprint || snapshot.routingPrepared === false) {
    const classification = classifyAutoPrint(node);
    const target = config.routingMode === "conditional"
      ? conditionalAutoPrintDestination(config.routingRules, { classification, nickname: node.nickname ?? job.nickname,
        sourceStatusId: job.sourceStatusId,
        businessDaysOut: node.customerDueAt ? businessDaysUntilDue(new Date(), new Date(node.customerDueAt)) : null })
      : destinationMappingForClassification(classification, config.categoryMappings);
    targetStatusId = target?.statusId ?? null;
    targetStatusName = target?.statusName ?? null;
    routingRule = config.routingMode === "conditional" ? target as import("./configValidation").AutoPrintRoutingRule | null : null;
  }
  let categoryAssignments;
  try {
    categoryAssignments = snapshot.orderKind === "invoice"
      ? planMerchCategories(node, routingRule, node.nickname ?? job.nickname, job.sourceStatusName) : [];
  } catch (error) {
    throw new WorkorderSkip(`Category review required: ${String(error)}`);
  }
  const [prepared] = await db.update(jobs).set({
    contentFingerprint: fingerprint, eligibilityCycle: eligibilityCycle ?? "initial",
    isReprint: !!prior, priorPrintedAt: prior?.printedAt ?? null, targetStatusId, targetStatusName,
    snapshotMetadata: { ...(job.snapshotMetadata as object), durableRetry: { ...snapshot, fingerprint, routingPrepared: true, routingRule, categoryAssignments } },
  }).where(and(eq(jobs.id, job.id), eq(jobs.leaseToken, job.leaseToken!), eq(jobs.status, "pending"),
    sql`${jobs.leaseUntil} > now()`)).returning();
  if (!prepared) throw new Error("Lease lost during print preparation");
  return prepared;
}
