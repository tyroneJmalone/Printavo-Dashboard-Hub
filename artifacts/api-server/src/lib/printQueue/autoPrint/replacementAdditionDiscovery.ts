import { createHash } from "node:crypto";
import { db, appSettingsTable, pvOrdersTable, pqPrintJobsTable, poFilesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getPrintavoClient } from "../../printavoGateway";
import type { PoFileLineItem } from "../../purchasing/poFiles";
import { planMakeupAdditions, type MakeupBaseline, type MakeupLine, type MakeupObservation, type HubLineReference } from "./replacementAdditionPlan";

const KEY = "autoprint.makeups-additions-baseline";
interface MakeupQueryResult {
  invoice: {
    id: string; visualId: string | number; nickname: string | null;
    lineItemGroups: { nodes: { id: string; lineItems: { nodes: Omit<MakeupLine, "groupId">[];
      pageInfo: { hasNextPage: boolean } } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  } | null;
}

export function makeupObservationQuery(orderId: string, after: string | null, includeVendor = true): string {
  return `query { invoice(id: ${JSON.stringify(orderId)}) {
    id visualId nickname
    lineItemGroups(first: 10${after ? `, after: ${JSON.stringify(after)}` : ""}) {
      nodes { id lineItems(first: 40) { nodes {
        id itemNumber color description sizes { size count }
        poLineItem { purchaseOrder { id visualPoId ${includeVendor ? "vendor { name company }" : ""} } }
      } pageInfo { hasNextPage } } }
      pageInfo { hasNextPage endCursor }
    }
  } }`;
}

export async function fetchMakeupObservation(orderId: string): Promise<MakeupObservation> {
  const observedAt = new Date().toISOString();
  const lines: MakeupLine[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();
  let nickname: string | null = null;
  for (let page = 0; page < 100; page++) {
    let response: MakeupQueryResult;
    try {
      response = await getPrintavoClient().query<MakeupQueryResult>(makeupObservationQuery(orderId, after));
    } catch (err) {
      // Deleted vendor records can null a non-nullable relation in Printavo.
      // Re-read the entire page without that field; never baseline partial data.
      if (!(err instanceof Error) || !err.message.includes("Cannot return null for non-nullable field PurchaseOrder.vendor")) throw err;
      response = await getPrintavoClient().query<MakeupQueryResult>(makeupObservationQuery(orderId, after, false));
    }
    const order = response.invoice;
    if (!order || order.id !== orderId || Number(order.visualId) !== 22787) throw new Error("Makeups invoice identity could not be verified");
    nickname = order.nickname;
    for (const group of order.lineItemGroups.nodes) {
      if (group.lineItems.pageInfo.hasNextPage) throw new Error("Makeups group exceeds complete line limit; no additions queued");
      lines.push(...group.lineItems.nodes.map(l => ({ ...l, groupId: group.id })));
    }
    if (!order.lineItemGroups.pageInfo.hasNextPage) {
      if (new Set(lines.map(l => l.id)).size !== lines.length) throw new Error("Makeups pagination repeated a line; no additions queued");
      return { orderId, nickname, observedAt, lines };
    }
    after = order.lineItemGroups.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error("Makeups group pagination incomplete");
    cursors.add(after);
  }
  throw new Error("Makeups group pagination exceeded safety limit");
}

/** Production run boundary only. Baseline and print reservations commit together. */
export async function discoverReplacementAdditions(runId: string): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const orders = await db.select({ id: pvOrdersTable.printavoId }).from(pvOrdersTable)
    .where(and(eq(pvOrdersTable.visualId, 22787), eq(pvOrdersTable.orderType, "invoice")));
  if (orders.length !== 1) throw new Error("Makeups invoice #22787 must have one verified invoice identity");
  const observation = await fetchMakeupObservation(orders[0].id);
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${KEY}))`);
    const [saved] = await tx.select().from(appSettingsTable).where(eq(appSettingsTable.key, KEY));
    const baseline = saved ? saved.value as MakeupBaseline : null;
    if (baseline && (!Array.isArray(baseline.seenLineIds) || !Number.isFinite(Date.parse(baseline.observedAt)))) {
      throw new Error("Makeups baseline invalid; manual review required");
    }
    const pos = await tx.select().from(poFilesTable).where(sql`${poFilesTable.submittedToVendorAt} IS NOT NULL AND
      EXISTS (SELECT 1 FROM jsonb_array_elements(${poFilesTable.lineItems}) li WHERE li->>'printavoOrderId' = ${observation.orderId})`);
    const references: HubLineReference[] = pos.flatMap(po => (po.lineItems as PoFileLineItem[]).map(line => ({
      poNumber: po.poNumber, vendorName: po.vendorName, submittedToVendorAt: po.submittedToVendorAt!.toISOString(), line,
    })));
    // Honor any legacy slip already reserved or accepted during a rolling publish.
    const previous = await tx.select({ snapshot: pqPrintJobsTable.snapshotMetadata }).from(pqPrintJobsTable)
      .where(and(eq(pqPrintJobsTable.docType, "replacement_slip"), eq(pqPrintJobsTable.visualId, "22787")));
    const extraSeen = previous.flatMap(p => {
      const value = p.snapshot as { po?: { lineItems?: PoFileLineItem[] } } | null;
      return (value?.po?.lineItems ?? []).flatMap(l => l.printavoOrderId === observation.orderId && l.printavoLineItemId ? [l.printavoLineItemId] : []);
    });
    const plan = planMakeupAdditions(observation, baseline ? { ...baseline, seenLineIds: [...baseline.seenLineIds, ...extraSeen] } : null, references);
    for (const snapshot of plan.slips) {
      const digest = createHash("sha256").update(JSON.stringify(snapshot.po.lineItems.map(l => l.printavoLineItemId).sort())).digest("hex");
      await tx.insert(pqPrintJobsTable).values({
        runId, docType: "replacement_slip", status: "queued", printavoOrderId: observation.orderId,
        visualId: "22787", nickname: observation.nickname, copies: 1,
        attemptKey: `makeups-additions:${observation.orderId}:${digest}`,
        snapshotMetadata: snapshot, reason: "new_makeups_lines",
      }).onConflictDoNothing();
    }
    await tx.insert(appSettingsTable).values({ key: KEY, value: plan.baseline })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: plan.baseline, updatedAt: new Date() } });
  });
}
