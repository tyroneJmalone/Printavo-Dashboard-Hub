import {
  db,
  pvOrdersTable,
  pvCustomersTable,
  pvContactsTable,
  pvStatusesTable,
  changeEventsTable,
  type InsertPvOrder,
  type InsertChangeEvent,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type {
  PvOrderNode,
  PvCustomerNode,
  PvContactNode,
  PvStatusNode,
} from "@workspace/printavo";
import {
  contentHashOf,
  moneyStr,
  dateOrNull,
  sameInstant,
  normalizeTimestamps,
} from "./differ";

export interface UpsertOpts {
  emitEvents: boolean;
  syncRunId: number | null;
}

export type UpsertOutcomeKind = "created" | "updated" | "unchanged" | "converted";

export interface UpsertOutcome {
  outcome: UpsertOutcomeKind;
  events: number;
}

interface EventBase {
  entityType: string;
  entityId: string;
  visualId: number | null;
  syncRunId: number | null;
}

function pushIfChanged(
  events: InsertChangeEvent[],
  base: EventBase,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  if ((oldValue ?? null) !== (newValue ?? null)) {
    events.push({ ...base, eventType: "field_change", field, oldValue, newValue });
  }
}

async function persistEvents(
  events: InsertChangeEvent[],
  opts: UpsertOpts,
): Promise<number> {
  if (!opts.emitEvents || events.length === 0) return 0;
  await db.insert(changeEventsTable).values(events);
  return events.length;
}

export async function upsertOrder(
  rawNode: PvOrderNode,
  orderType: "quote" | "invoice",
  opts: UpsertOpts,
): Promise<UpsertOutcome> {
  const node = normalizeTimestamps(rawNode);
  const hash = contentHashOf(node);
  const [existing] = await db
    .select()
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.printavoId, node.id))
    .limit(1);

  if (existing && existing.contentHash === hash) {
    await db
      .update(pvOrdersTable)
      .set({ syncedAt: new Date() })
      .where(eq(pvOrdersTable.printavoId, node.id));
    return { outcome: "unchanged", events: 0 };
  }

  const row: InsertPvOrder = {
    printavoId: node.id,
    visualId: node.visualId,
    orderType,
    statusId: node.status?.id ?? null,
    statusName: node.status?.name ?? null,
    nickname: node.nickname ?? null,
    total: moneyStr(node.total),
    amountOutstanding: moneyStr(node.amountOutstanding),
    customerDueAt: dateOrNull(node.customerDueAt),
    contactId: node.contact?.id ?? null,
    contactName: node.contact?.fullName ?? null,
    contactEmail: node.contact?.email ?? null,
    customerId: node.contact?.customer?.id ?? null,
    customerCompany: node.contact?.customer?.companyName ?? null,
    ownerEmail: node.owner?.email ?? null,
    printavoCreatedAt: dateOrNull(node.timestamps?.createdAt),
    printavoUpdatedAt: dateOrNull(node.timestamps?.updatedAt),
    data: node,
    contentHash: hash,
    syncedAt: new Date(),
  };

  const events: InsertChangeEvent[] = [];
  const base: EventBase = {
    entityType: "order",
    entityId: node.id,
    visualId: node.visualId,
    syncRunId: opts.syncRunId,
  };

  if (existing) {
    if ((existing.statusId ?? null) !== (row.statusId ?? null)) {
      events.push({
        ...base,
        eventType: "status_change",
        field: "status",
        oldValue: existing.statusName,
        newValue: row.statusName,
      });
    }
    pushIfChanged(events, base, "total", existing.total, row.total);
    pushIfChanged(
      events,
      base,
      "amountOutstanding",
      existing.amountOutstanding,
      row.amountOutstanding,
    );
    pushIfChanged(events, base, "nickname", existing.nickname, row.nickname);
    pushIfChanged(events, base, "owner", existing.ownerEmail, row.ownerEmail);
    if (!sameInstant(existing.customerDueAt, row.customerDueAt ?? null)) {
      events.push({
        ...base,
        eventType: "field_change",
        field: "customerDueAt",
        oldValue: existing.customerDueAt?.toISOString() ?? null,
        newValue: row.customerDueAt?.toISOString() ?? null,
      });
    }
    if (events.length === 0) {
      events.push({ ...base, eventType: "updated" });
    }
    await db
      .update(pvOrdersTable)
      .set(row)
      .where(eq(pvOrdersTable.printavoId, node.id));
    const emitted = await persistEvents(events, opts);
    return { outcome: "updated", events: emitted };
  }

  let converted = false;
  if (orderType === "invoice") {
    const [priorQuote] = await db
      .select()
      .from(pvOrdersTable)
      .where(
        and(
          eq(pvOrdersTable.visualId, node.visualId),
          eq(pvOrdersTable.orderType, "quote"),
        ),
      )
      .limit(1);
    if (priorQuote) {
      await db
        .delete(pvOrdersTable)
        .where(eq(pvOrdersTable.printavoId, priorQuote.printavoId));
      row.firstSeenAt = priorQuote.firstSeenAt;
      events.push({
        ...base,
        eventType: "converted",
        field: "orderType",
        oldValue: { printavoId: priorQuote.printavoId, orderType: "quote" },
        newValue: { printavoId: node.id, orderType: "invoice" },
      });
      converted = true;
    }
  }
  if (!converted) {
    events.push({
      ...base,
      eventType: "created",
      newValue: { statusName: row.statusName, total: row.total },
    });
  }
  await db.insert(pvOrdersTable).values(row);
  const emitted = await persistEvents(events, opts);
  return { outcome: converted ? "converted" : "created", events: emitted };
}

export async function upsertCustomer(
  rawNode: PvCustomerNode,
  opts: UpsertOpts,
): Promise<UpsertOutcome> {
  const node = normalizeTimestamps(rawNode);
  const hash = contentHashOf(node);
  const [existing] = await db
    .select()
    .from(pvCustomersTable)
    .where(eq(pvCustomersTable.printavoId, node.id))
    .limit(1);

  if (existing && existing.contentHash === hash) {
    await db
      .update(pvCustomersTable)
      .set({ syncedAt: new Date() })
      .where(eq(pvCustomersTable.printavoId, node.id));
    return { outcome: "unchanged", events: 0 };
  }

  const row = {
    printavoId: node.id,
    companyName: node.companyName ?? null,
    primaryContactId: node.primaryContact?.id ?? null,
    ownerEmail: node.owner?.email ?? null,
    printavoCreatedAt: dateOrNull(node.timestamps?.createdAt),
    printavoUpdatedAt: dateOrNull(node.timestamps?.updatedAt),
    data: node,
    contentHash: hash,
    syncedAt: new Date(),
  };

  const events: InsertChangeEvent[] = [];
  const base: EventBase = {
    entityType: "customer",
    entityId: node.id,
    visualId: null,
    syncRunId: opts.syncRunId,
  };

  if (existing) {
    pushIfChanged(events, base, "companyName", existing.companyName, row.companyName);
    pushIfChanged(events, base, "owner", existing.ownerEmail, row.ownerEmail);
    if (events.length === 0) events.push({ ...base, eventType: "updated" });
    await db
      .update(pvCustomersTable)
      .set(row)
      .where(eq(pvCustomersTable.printavoId, node.id));
    const emitted = await persistEvents(events, opts);
    return { outcome: "updated", events: emitted };
  }

  events.push({
    ...base,
    eventType: "created",
    newValue: { companyName: row.companyName },
  });
  await db.insert(pvCustomersTable).values(row);
  const emitted = await persistEvents(events, opts);
  return { outcome: "created", events: emitted };
}

export async function upsertContact(
  rawNode: PvContactNode,
  opts: UpsertOpts,
): Promise<UpsertOutcome> {
  const node = normalizeTimestamps(rawNode);
  const hash = contentHashOf(node);
  const [existing] = await db
    .select()
    .from(pvContactsTable)
    .where(eq(pvContactsTable.printavoId, node.id))
    .limit(1);

  if (existing && existing.contentHash === hash) {
    await db
      .update(pvContactsTable)
      .set({ syncedAt: new Date() })
      .where(eq(pvContactsTable.printavoId, node.id));
    return { outcome: "unchanged", events: 0 };
  }

  const row = {
    printavoId: node.id,
    fullName: node.fullName ?? null,
    email: node.email ?? null,
    phone: node.phone ?? null,
    customerId: node.customer?.id ?? null,
    printavoCreatedAt: dateOrNull(node.timestamps?.createdAt),
    printavoUpdatedAt: dateOrNull(node.timestamps?.updatedAt),
    data: node,
    contentHash: hash,
    syncedAt: new Date(),
  };

  const events: InsertChangeEvent[] = [];
  const base: EventBase = {
    entityType: "contact",
    entityId: node.id,
    visualId: null,
    syncRunId: opts.syncRunId,
  };

  if (existing) {
    pushIfChanged(events, base, "fullName", existing.fullName, row.fullName);
    pushIfChanged(events, base, "email", existing.email, row.email);
    pushIfChanged(events, base, "phone", existing.phone, row.phone);
    pushIfChanged(events, base, "customer", existing.customerId, row.customerId);
    if (events.length === 0) events.push({ ...base, eventType: "updated" });
    await db
      .update(pvContactsTable)
      .set(row)
      .where(eq(pvContactsTable.printavoId, node.id));
    const emitted = await persistEvents(events, opts);
    return { outcome: "updated", events: emitted };
  }

  events.push({
    ...base,
    eventType: "created",
    newValue: { fullName: row.fullName, email: row.email },
  });
  await db.insert(pvContactsTable).values(row);
  const emitted = await persistEvents(events, opts);
  return { outcome: "created", events: emitted };
}

export async function upsertStatus(
  rawNode: PvStatusNode,
  opts: UpsertOpts,
): Promise<UpsertOutcome> {
  const node = normalizeTimestamps(rawNode);
  const hash = contentHashOf(node);
  const [existing] = await db
    .select()
    .from(pvStatusesTable)
    .where(eq(pvStatusesTable.printavoId, node.id))
    .limit(1);

  if (existing && existing.contentHash === hash) {
    await db
      .update(pvStatusesTable)
      .set({ syncedAt: new Date() })
      .where(eq(pvStatusesTable.printavoId, node.id));
    return { outcome: "unchanged", events: 0 };
  }

  const events: InsertChangeEvent[] = [];
  const base: EventBase = {
    entityType: "status",
    entityId: node.id,
    visualId: null,
    syncRunId: opts.syncRunId,
  };

  if (existing) {
    pushIfChanged(events, base, "name", existing.name, node.name);
    if (events.length === 0) events.push({ ...base, eventType: "updated" });
    await db
      .update(pvStatusesTable)
      .set({ name: node.name, data: node, contentHash: hash, syncedAt: new Date() })
      .where(eq(pvStatusesTable.printavoId, node.id));
    const emitted = await persistEvents(events, opts);
    return { outcome: "updated", events: emitted };
  }

  events.push({ ...base, eventType: "created", newValue: { name: node.name } });
  await db.insert(pvStatusesTable).values({
    printavoId: node.id,
    name: node.name,
    data: node,
    contentHash: hash,
  });
  const emitted = await persistEvents(events, opts);
  return { outcome: "created", events: emitted };
}
