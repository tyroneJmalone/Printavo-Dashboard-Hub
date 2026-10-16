import { db, pool, externalVendorOrdersTable as external, vendorOrdersTable as hub } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { sanMarClient, ssClient } from "./vendorSubmit";
import type { SSOrderInfo } from "@workspace/ss-activewear";
import { referenceKey as key, vendorComplete as complete, matchesHub } from "./externalTrackingPolicy";

type Snapshot = {
  dateBasis: string;
  orderDate: string | null;
  vendorStatus: string | null;
  deliveryStatus: string | null;
  warehouse: string | null;
  orderNumbers: string[];
  tracking: { trackingNumber: string; carrier: string | null }[];
  terminal: boolean;
};
type Candidate = { vendor: string; reference: string; poNumber: string; snapshot: Snapshot };
type Row = typeof external.$inferSelect;

function fromSs(o: SSOrderInfo): Candidate {
  if (!o.orderNumber) throw new Error("S&S returned no vendor order number");
  return {
    vendor: "ss", reference: o.orderNumber, poNumber: o.poNumber ?? "",
    snapshot: {
      dateBasis: "Order placed", orderDate: o.orderDate ?? null,
      vendorStatus: o.orderStatus, deliveryStatus: o.deliveryStatus ?? null,
      warehouse: o.warehouse ?? null, orderNumbers: [o.orderNumber],
      tracking: o.trackingNumber ? [{ trackingNumber: o.trackingNumber, carrier: o.shippingCarrier }] : [],
      terminal: complete(o.orderStatus) || /^shipped\s*-\s*delivered$/i.test(o.deliveryStatus?.trim() ?? ""),
    },
  };
}

async function fromSanmar(poNumber: string, salesOrder?: string): Promise<Candidate> {
  const client = sanMarClient();
  const status = await client.getOrderStatus(salesOrder ?? poNumber, salesOrder ? 2 : 1);
  const shipment = await client.getShipmentNotification(salesOrder ?? poNumber, salesOrder ? 2 : 1);
  if (!status.found && !shipment.found) throw new Error(`SanMar no longer reports PO ${poNumber}`);
  const statuses = [...new Set(status.details.map(d => d.statusName).filter((s): s is string => !!s))];
  return {
    vendor: "sanmar", reference: salesOrder ? `SO:${salesOrder}` : poNumber, poNumber,
    snapshot: {
      dateBasis: "Status updated", orderDate: null,
      vendorStatus: statuses.join(", ") || null, deliveryStatus: null, warehouse: shipment.warehouses?.join("; ") || null,
      orderNumbers: [...new Set([...status.details.map(d => d.factoryOrderNumber), ...shipment.packages.map(p => p.orderNumber)].filter((s): s is string => !!s))],
      tracking: [...new Map(shipment.packages.filter(p => p.trackingNumber).map(p => [p.trackingNumber, {trackingNumber: p.trackingNumber!, carrier: p.carrier}])).values()],
      terminal: statuses.length > 0 && statuses.every(complete),
    },
  };
}

async function dto(row: Row) {
  // Match the complete reference, never guess invoices by splitting abbreviated POs.
  // Only remove conventional P prefix and slash/space separators, not arbitrary
  // punctuation which may distinguish unrelated customer references.
  const invoices = await pool.query<{ orderId: string; visualId: number }>(`
    SELECT DISTINCT o.printavo_id AS "orderId",o.visual_id AS "visualId"
    FROM pv_orders o WHERE o.order_type='invoice' AND (
      o.visual_id::text=$1 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(o.extras->'lineItems','[]')) line
        WHERE regexp_replace(upper(regexp_replace(line->'poLineItem'->'purchaseOrder'->>'visualPoId','^[Pp](?=[0-9])','')), '[/[:space:]]', '', 'g')
          = regexp_replace(upper(regexp_replace($1,'^[Pp](?=[0-9])','')), '[/[:space:]]', '', 'g')
          AND length(regexp_replace($1,'[^a-zA-Z0-9]','','g')) > 0
      )) ORDER BY o.visual_id`, [row.poNumber]);
  return { id: row.id, vendor: row.vendor, reference: row.reference, poNumber: row.poNumber,
    ...(row.snapshot as Snapshot), invoices: invoices.rows, checkedAt: row.checkedAt.toISOString() };
}

export async function listExternalVendorOrders() {
  const [rows, submitted] = await Promise.all([
    db.select().from(external).where(eq(external.archived, false)).orderBy(desc(external.createdAt)),
    db.select().from(hub).where(eq(hub.mode, "live")),
  ]);
  // An order subsequently identified as Hub-owned must not appear in both groups.
  return Promise.all(rows.filter(r => !matchesHub({...r, snapshot: r.snapshot as Snapshot}, submitted)).map(dto));
}

async function save(candidate: Candidate) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('external-vendor-history-import'))`);
    const submitted = await tx.select().from(hub).where(eq(hub.mode, "live"));
    if (matchesHub(candidate, submitted)) return "hub" as const;
    const [existing] = await tx.select().from(external).where(and(eq(external.vendor, candidate.vendor), eq(external.reference, candidate.reference)));
    if (existing) {
      // Preserve terminal tracking snapshots rather than repeatedly fetching them.
      if (!(existing.snapshot as Snapshot).terminal) {
        candidate.snapshot.tracking = [...new Map([...(existing.snapshot as Snapshot).tracking, ...candidate.snapshot.tracking].map(t => [t.trackingNumber,t])).values()];
        await tx.update(external).set({...candidate, checkedAt: new Date()}).where(eq(external.id, existing.id));
      }
      return "updated" as const;
    }
    await tx.insert(external).values({...candidate, checkedAt: new Date()});
    return "imported" as const;
  });
}

let importing = false;
export async function importExternalVendorOrders() {
  if (importing) throw new Error("An external history import is already running");
  importing = true;
  const through = new Date();
  const since = new Date(through.getTime() - 7 * 86400000);
  const result = {since: since.toISOString(), through: through.toISOString(), imported: 0, updated: 0, skippedHub: 0, errors: [] as string[]};
  const record = async (candidate: Candidate) => {
    const outcome = await save(candidate);
    if (outcome === "hub") result.skippedHub++;
    else result[outcome]++;
  };
  try {
    try {
      const recent = await ssClient().getRecentOrders(since);
      const submitted = await db.select().from(hub).where(eq(hub.mode,"live"));
      for (const order of recent.orders) {
        const candidate = fromSs(order);
        if (matchesHub(candidate,submitted)) { result.skippedHub++; continue; }
        const [existing] = await db.select().from(external).where(and(eq(external.vendor,"ss"),eq(external.reference,candidate.reference)));
        if (existing && (existing.snapshot as Snapshot).terminal) { result.updated++; continue; }
        try {
          const details = await ssClient().getOrders(candidate.reference);
          const exact = details.orders.find(o => o.orderNumber === candidate.reference);
          if (!exact) throw new Error("Vendor order details were not returned");
          await record(fromSs(exact));
        } catch (e) { result.errors.push(`S&S order ${candidate.reference}: ${e instanceof Error ? e.message : "Lookup failed"}`); }
      }
    } catch (e) { result.errors.push(`S&S: ${e instanceof Error ? e.message : "History lookup failed"}`); }
    try {
      const history = await sanMarClient().getRecentlyUpdatedOrders(since);
      const submitted = await db.select().from(hub).where(eq(hub.mode, "live"));
      const seen = new Set<string>();
      for (const entry of history) {
        const po = entry.poNumber;
        const noPo = !po || /^(not available|n\/a)$/i.test(po);
        const salesOrder = noPo ? entry.orderNumber ?? undefined : undefined;
        if (noPo && !salesOrder) { result.errors.push("SanMar returned an order without a usable PO or sales order number"); continue; }
        const reference = salesOrder ? `SO:${salesOrder}` : po;
        if (seen.has(reference)) continue;
        seen.add(reference);
        if (submitted.some(h => h.vendor === "sanmar" && key(h.poNumber) === key(po))) { result.skippedHub++; continue; }
        const [existing] = await db.select().from(external).where(and(eq(external.vendor,"sanmar"),eq(external.reference,reference)));
        if (existing && (existing.snapshot as Snapshot).terminal) { result.updated++; continue; }
        try { await record(await fromSanmar(po, salesOrder)); }
        catch (e) { result.errors.push(`SanMar PO ${po}: ${e instanceof Error ? e.message : "Lookup failed"}`); }
      }
    } catch (e) { result.errors.push(`SanMar: ${e instanceof Error ? e.message : "History lookup failed"}`); }
    return result;
  } finally { importing = false; }
}

export async function refreshExternalVendorOrder(id: string) {
  const [row] = await db.select().from(external).where(eq(external.id, id));
  if (!row) return null;
  // Explicit checks may enrich completed legacy records. Routine Refresh active
  // still excludes them, so completed POs are not repeatedly polled.
  let candidate: Candidate;
  if (row.vendor === "sanmar") candidate = await fromSanmar(row.poNumber, row.reference.startsWith("SO:") ? row.reference.slice(3) : undefined);
  else {
    const res = await ssClient().getOrders(row.reference);
    const match = res.orders.find(o => o.orderNumber === row.reference);
    if (!match) throw new Error("Vendor did not return the tracked order; previous tracking retained");
    candidate = fromSs(match);
  }
  candidate.snapshot.tracking = [...new Map([...(row.snapshot as Snapshot).tracking, ...candidate.snapshot.tracking].map(t => [t.trackingNumber,t])).values()];
  candidate.snapshot.orderDate ??= (row.snapshot as Snapshot).orderDate;
  candidate.snapshot.warehouse ??= (row.snapshot as Snapshot).warehouse;
  const [saved] = await db.update(external).set({...candidate, checkedAt: new Date()}).where(eq(external.id, id)).returning();
  return dto(saved);
}
