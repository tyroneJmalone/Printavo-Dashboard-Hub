import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  pvContactsTable,
  pvCustomersTable,
  pvImprintsTable,
  pvLineItemGroupsTable,
  pvLineItemsTable,
  pvOrdersTable,
  pvPaymentsTable,
} from "@workspace/db";
import { searchQuoteCustomers } from "../quoteDrafts/service";

/**
 * Printavo fact lookups for the context layer. Everything reads the Hub's
 * synced Printavo snapshot (never the live Printavo API) so a burst of AI
 * tool calls can never hit Printavo rate limits.
 *
 * Date semantics: date-only columns are returned as YYYY-MM-DD strings
 * exactly as Printavo stores them (calendar dates at UTC midnight —
 * consumers must not shift them into a local timezone).
 */

function money(value: string | null): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export async function lookupCustomers(query: string) {
  const candidates = await searchQuoteCustomers(query);
  return {
    query,
    candidates: candidates.slice(0, 10).map((c) => ({
      customerId: c.customerId,
      companyName: c.companyName,
      contactName: c.contactName,
      contactEmail: c.contactEmail,
      matchType: c.matchType,
    })),
    note:
      candidates.length === 0
        ? "No customers matched. Try fewer or different words (company name or contact name/email)."
        : "matchType 'exact' means a whole search term matched a name exactly; 'possible' matches need human confirmation before acting on customer-specific data.",
  };
}

export async function getCustomerSummary(customerId: string) {
  const [customer] = await db
    .select()
    .from(pvCustomersTable)
    .where(eq(pvCustomersTable.printavoId, customerId));
  if (!customer) {
    return { found: false, customerId, note: "No customer with this id in the Hub's Printavo snapshot." };
  }
  const [primaryContact] = customer.primaryContactId
    ? await db
        .select()
        .from(pvContactsTable)
        .where(eq(pvContactsTable.printavoId, customer.primaryContactId))
    : [];
  const [stats] = await db
    .select({
      totalOrders: sql<number>`count(*)::int`,
      invoiceCount: sql<number>`(count(*) filter (where ${pvOrdersTable.orderType} = 'invoice'))::int`,
      quoteCount: sql<number>`(count(*) filter (where ${pvOrdersTable.orderType} = 'quote'))::int`,
      lifetimeInvoiceTotal: sql<string>`coalesce(sum(${pvOrdersTable.total}) filter (where ${pvOrdersTable.orderType} = 'invoice'), 0)::text`,
      outstandingBalance: sql<string>`coalesce(sum(${pvOrdersTable.amountOutstanding}) filter (where ${pvOrdersTable.orderType} = 'invoice'), 0)::text`,
      firstOrderAt: sql<string | null>`min(${pvOrdersTable.printavoCreatedAt})::text`,
      lastOrderAt: sql<string | null>`max(${pvOrdersTable.printavoCreatedAt})::text`,
    })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.customerId, customerId));
  const recent = await db
    .select({
      visualId: pvOrdersTable.visualId,
      orderType: pvOrdersTable.orderType,
      statusName: pvOrdersTable.statusName,
      nickname: pvOrdersTable.nickname,
      total: pvOrdersTable.total,
      createdAt: pvOrdersTable.printavoCreatedAt,
    })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.customerId, customerId))
    .orderBy(desc(pvOrdersTable.printavoCreatedAt))
    .limit(5);
  return {
    found: true,
    customer: {
      customerId: customer.printavoId,
      companyName: customer.companyName,
      ownerEmail: customer.ownerEmail,
      primaryContact: primaryContact
        ? {
            name: primaryContact.fullName,
            email: primaryContact.email,
            phone: primaryContact.phone,
          }
        : null,
    },
    stats: {
      totalOrders: stats?.totalOrders ?? 0,
      invoiceCount: stats?.invoiceCount ?? 0,
      quoteCount: stats?.quoteCount ?? 0,
      lifetimeInvoiceTotal: money(stats?.lifetimeInvoiceTotal ?? null),
      outstandingBalance: money(stats?.outstandingBalance ?? null),
      firstOrderAt: stats?.firstOrderAt ?? null,
      lastOrderAt: stats?.lastOrderAt ?? null,
    },
    recentOrders: recent.map((o) => ({
      visualId: o.visualId,
      orderType: o.orderType,
      statusName: o.statusName,
      nickname: o.nickname,
      total: money(o.total),
      createdAt: iso(o.createdAt),
    })),
    note: "Order history covers the Hub's synced window (about the last 12 months plus everything since sync began).",
  };
}

export async function getRecentOrders(customerId: string, limit: number) {
  const rows = await db
    .select()
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.customerId, customerId))
    .orderBy(desc(pvOrdersTable.printavoCreatedAt))
    .limit(limit);
  return {
    customerId,
    orders: rows.map((o) => ({
      visualId: o.visualId,
      orderType: o.orderType,
      statusName: o.statusName,
      nickname: o.nickname,
      total: money(o.total),
      amountOutstanding: money(o.amountOutstanding),
      invoiceDate: o.invoiceAt,
      customerDueAt: iso(o.customerDueAt),
      paymentDueDate: o.paymentDueAt,
      contactName: o.contactName,
      contactEmail: o.contactEmail,
      createdAt: iso(o.printavoCreatedAt),
    })),
  };
}

export async function getOrderDetails(visualId: number) {
  const orders = await db
    .select()
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.visualId, visualId))
    .orderBy(desc(pvOrdersTable.printavoCreatedAt));
  if (orders.length === 0) {
    return { found: false, visualId, note: "No order with this visual id in the Hub's Printavo snapshot." };
  }
  // Quote→invoice conversion can leave both records under one visual id —
  // prefer the invoice (the live document a customer actually pays).
  const order = orders.find((o) => o.orderType === "invoice") ?? orders[0]!;
  const [groups, items, imprints, payments] = await Promise.all([
    db
      .select()
      .from(pvLineItemGroupsTable)
      .where(eq(pvLineItemGroupsTable.orderId, order.printavoId))
      .orderBy(pvLineItemGroupsTable.position),
    db
      .select()
      .from(pvLineItemsTable)
      .where(eq(pvLineItemsTable.orderId, order.printavoId)),
    db
      .select()
      .from(pvImprintsTable)
      .where(eq(pvImprintsTable.orderId, order.printavoId)),
    db
      .select()
      .from(pvPaymentsTable)
      .where(eq(pvPaymentsTable.orderVisualId, visualId))
      .orderBy(desc(pvPaymentsTable.transactionDate)),
  ]);
  return {
    found: true,
    order: {
      visualId: order.visualId,
      orderType: order.orderType,
      statusName: order.statusName,
      nickname: order.nickname,
      total: money(order.total),
      amountOutstanding: money(order.amountOutstanding),
      customerCompany: order.customerCompany,
      customerId: order.customerId,
      contactName: order.contactName,
      contactEmail: order.contactEmail,
      ownerEmail: order.ownerEmail,
      invoiceDate: order.invoiceAt,
      customerDueAt: iso(order.customerDueAt),
      productionDueAt: iso(order.productionDueAt),
      paymentDueDate: order.paymentDueAt,
      createdAt: iso(order.printavoCreatedAt),
      updatedAt: iso(order.printavoUpdatedAt),
    },
    lineItemGroups: groups.map((group) => ({
      position: group.position,
      items: items
        .filter((item) => item.groupId === group.printavoId)
        .map((item) => ({
          styleNumber: item.itemNumber,
          color: item.color,
          description: item.description,
          brand: item.brand,
          category: item.categoryName,
          quantity: item.items,
          unitPrice: money(item.price),
          sizes: item.sizes,
        })),
      decorations: imprints
        .filter((imprint) => imprint.groupId === group.printavoId)
        .map((imprint) => ({
          typeOfWork: imprint.typeOfWork,
          details: imprint.details,
          pricingMatrix: imprint.matrixName,
          pricingColumn: imprint.columnName,
        })),
    })),
    payments: payments.map((p) => ({
      type: p.typename,
      amount: money(p.amount),
      date: p.transactionDate,
      source: p.source,
      description: p.description,
      processing: p.processing,
    })),
  };
}
