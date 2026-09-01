import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pvOrdersTable,
  pvLineItemsTable,
  pvStatusesTable,
  pvFilesTable,
  pvContactsTable,
  reorderRequestsTable,
} from "@workspace/db";
import { and, eq, desc, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  SearchReorderPortalOrdersQueryParams,
  SubmitReorderRequestBody,
} from "@workspace/api-zod";
import { notChipplySql } from "../lib/chipply/matching";
import { sendReorderRequestEmail } from "../lib/reorder/email";

/**
 * PUBLIC Reorder Portal routes (no staff session — mounted above
 * requireStaff). Customers look up their past invoices from the synced
 * Printavo snapshot and submit reorder requests, which are stored in
 * reorder_requests and emailed to the sales team.
 *
 * Exposure is deliberately minimal: invoices only, Chipply shells
 * excluded, capped result count, and only the fields the portal renders
 * (no payment/outstanding amounts, no owner/contact internals).
 */

const router: IRouter = Router();

/* ── naive in-memory rate limiting (per IP, per route family) ────────── */

const hits = new Map<string, number[]>();

function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // Opportunistic pruning so the map can't grow unbounded.
  if (hits.size > 10_000) {
    for (const [k, arr] of hits) {
      if (arr.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

/* ── size label mapping (Printavo LineItemSize enum → display label) ── */

const SIZE_LABEL_MAP: Record<string, string> = {
  size_yxs: "Youth XS",
  size_ys: "Youth S",
  size_ym: "Youth M",
  size_yl: "Youth L",
  size_yxl: "Youth XL",
  size_xs: "XS",
  size_s: "S",
  size_m: "M",
  size_l: "L",
  size_xl: "XL",
  size_2xl: "2XL",
  size_3xl: "3XL",
  size_4xl: "4XL",
  size_5xl: "5XL",
  size_6xl: "6XL",
  size_other: "Other",
  size_6m: "6M",
  size_12m: "12M",
  size_18m: "18M",
  size_24m: "24M",
  size_2t: "2T",
  size_3t: "3T",
  size_4t: "4T",
  size_5t: "5T",
};

function sizeLabel(raw: string): string {
  return (
    SIZE_LABEL_MAP[raw] ??
    raw.replace(/^size_/, "").replace(/_/g, " ").toUpperCase()
  );
}

/* ── GET /reorder-portal/orders ──────────────────────────────────────── */

const MAX_ORDERS = 20;

interface ExtrasMockup {
  fullImageUrl?: unknown;
}
interface ExtrasLineItem {
  id?: unknown;
  mockups?: ExtrasMockup[] | null;
}

router.get("/reorder-portal/orders", async (req: Request, res: Response) => {
  if (!allow(`search:${clientIp(req)}`, 30, 60_000)) {
    res.status(429).json({ error: "Too many searches — please slow down" });
    return;
  }
  const parsed = SearchReorderPortalOrdersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid search" });
    return;
  }
  const q = parsed.data.q.trim();
  const type = parsed.data.type;
  if (q.length < 2) {
    res.status(400).json({ error: "Invalid search" });
    return;
  }

  try {
    const baseConds = [
      eq(pvOrdersTable.orderType, "invoice"),
      sql.raw(notChipplySql("pv_orders.nickname")),
    ];

    let matchCond;
    if (type === "email") {
      const email = q.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: "Invalid email address" });
        return;
      }
      // Match orders by contact email, plus any orders belonging to
      // customers that have a contact with this email (contacts are the
      // reliable email source — customer typed columns are not).
      const contactCustomers = await db
        .selectDistinct({ customerId: pvContactsTable.customerId })
        .from(pvContactsTable)
        .where(sql`lower(${pvContactsTable.email}) = ${email}`);
      const customerIds = contactCustomers
        .map((r) => r.customerId)
        .filter((id): id is string => !!id);
      matchCond =
        customerIds.length > 0
          ? or(
              sql`lower(${pvOrdersTable.contactEmail}) = ${email}`,
              inArray(pvOrdersTable.customerId, customerIds),
            )
          : sql`lower(${pvOrdersTable.contactEmail}) = ${email}`;
    } else {
      // Escape LIKE wildcards so "%"/"_" in the query stay literal —
      // otherwise q=%% would match every company.
      const escaped = q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
      const needle = `%${escaped}%`;
      matchCond = sql`lower(${pvOrdersTable.customerCompany}) like ${needle}`;
    }

    const ps = alias(pvStatusesTable, "ps");
    const orders = await db
      .select({
        id: pvOrdersTable.printavoId,
        visualId: pvOrdersTable.visualId,
        nickname: pvOrdersTable.nickname,
        statusName: pvOrdersTable.statusName,
        statusColor: sql<string | null>`${ps.data}->>'color'`,
        total: pvOrdersTable.total,
        invoiceDate: pvOrdersTable.invoiceAt,
        customerCompany: pvOrdersTable.customerCompany,
        extras: pvOrdersTable.extras,
      })
      .from(pvOrdersTable)
      .leftJoin(ps, eq(ps.printavoId, pvOrdersTable.statusId))
      .where(and(...baseConds, matchCond))
      .orderBy(
        sql`${pvOrdersTable.invoiceAt} desc nulls last`,
        desc(pvOrdersTable.printavoCreatedAt),
      )
      .limit(MAX_ORDERS);

    const orderIds = orders.map((o) => o.id);

    const [lineItems, mockupFiles] =
      orderIds.length === 0
        ? [[], []]
        : await Promise.all([
            db
              .select({
                id: pvLineItemsTable.printavoId,
                orderId: pvLineItemsTable.orderId,
                itemNumber: pvLineItemsTable.itemNumber,
                color: pvLineItemsTable.color,
                description: pvLineItemsTable.description,
                items: pvLineItemsTable.items,
                sizes: pvLineItemsTable.sizes,
              })
              .from(pvLineItemsTable)
              .where(inArray(pvLineItemsTable.orderId, orderIds)),
            db
              .select({
                orderId: pvFilesTable.orderPrintavoId,
                sourceUrl: pvFilesTable.sourceUrl,
              })
              .from(pvFilesTable)
              .where(
                and(
                  inArray(pvFilesTable.orderPrintavoId, orderIds),
                  eq(pvFilesTable.sourceKind, "mockup"),
                ),
              )
              .orderBy(pvFilesTable.firstSeenAt),
          ]);

    const orderMockups = new Map<string, string[]>();
    for (const f of mockupFiles) {
      const list = orderMockups.get(f.orderId) ?? [];
      if (list.length < 30 && !list.includes(f.sourceUrl)) list.push(f.sourceUrl);
      orderMockups.set(f.orderId, list);
    }

    const lineItemsByOrder = new Map<string, typeof lineItems>();
    for (const li of lineItems) {
      const list = lineItemsByOrder.get(li.orderId) ?? [];
      list.push(li);
      lineItemsByOrder.set(li.orderId, list);
    }

    const result = orders.map((o) => {
      // Per-line mockups come from the extras blob (extras.lineItems[].id
      // matches pv_line_items.printavo_id).
      const extras = (o.extras ?? null) as { lineItems?: ExtrasLineItem[] } | null;
      const lineMockups = new Map<string, string[]>();
      for (const eli of extras?.lineItems ?? []) {
        if (typeof eli?.id !== "string") continue;
        const urls = (eli.mockups ?? [])
          .map((m) => m?.fullImageUrl)
          .filter((u): u is string => typeof u === "string" && u.startsWith("http"))
          .slice(0, 20);
        if (urls.length > 0) lineMockups.set(eli.id, urls);
      }

      const rawItems = (lineItemsByOrder.get(o.id) ?? []).slice(0, 100);
      return {
        id: o.id,
        visualId: o.visualId ?? null,
        nickname: o.nickname ?? null,
        statusName: o.statusName ?? null,
        statusColor: o.statusColor ?? null,
        total: o.total != null ? Number(o.total) : null,
        invoiceDate: o.invoiceDate ?? null,
        customerCompany: o.customerCompany ?? null,
        mockupUrls: orderMockups.get(o.id) ?? [],
        lineItems: rawItems.map((li) => {
          const sizes = Array.isArray(li.sizes)
            ? (li.sizes as Array<{ size?: unknown; count?: unknown }>)
                .filter(
                  (s) => typeof s?.size === "string" && typeof s?.count === "number",
                )
                .slice(0, 50)
                .map((s) => ({
                  size: s.size as string,
                  label: sizeLabel(s.size as string),
                  count: s.count as number,
                }))
            : [];
          return {
            id: li.id,
            itemNumber: li.itemNumber ?? null,
            color: li.color ?? null,
            description: li.description ?? null,
            totalQty: li.items ?? 0,
            sizes,
            mockupUrls: lineMockups.get(li.id) ?? [],
          };
        }),
      };
    });

    res.json({ orders: result });
  } catch (err) {
    req.log.error({ err }, "Reorder portal search failed");
    res.status(500).json({ error: "Search failed" });
  }
});

/* ── POST /reorder-portal/requests ───────────────────────────────────── */

router.post("/reorder-portal/requests", async (req: Request, res: Response) => {
  if (!allow(`submit:${clientIp(req)}`, 5, 60_000)) {
    res.status(429).json({ error: "Too many requests — please try again in a minute" });
    return;
  }
  const parsed = SubmitReorderRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const body = parsed.data;

  try {
    // The referenced order must exist in the snapshot AND be eligible for
    // the portal (same invoice + non-Chipply filter as search) — prevents
    // junk rows from hand-crafted submissions against arbitrary orders.
    const order = await db
      .select({
        id: pvOrdersTable.printavoId,
        visualId: pvOrdersTable.visualId,
        nickname: pvOrdersTable.nickname,
      })
      .from(pvOrdersTable)
      .where(
        and(
          eq(pvOrdersTable.printavoId, body.orderId),
          eq(pvOrdersTable.orderType, "invoice"),
          sql.raw(notChipplySql("pv_orders.nickname")),
        ),
      )
      .limit(1);
    if (order.length === 0) {
      res.status(400).json({ error: "Unknown order" });
      return;
    }

    // Any submitted lineItemId must actually belong to this order.
    const orderLineIds = new Set(
      (
        await db
          .select({ id: pvLineItemsTable.printavoId })
          .from(pvLineItemsTable)
          .where(eq(pvLineItemsTable.orderId, order[0].id))
      ).map((r) => r.id),
    );
    const badLine = body.items.find(
      (it) => it.lineItemId != null && !orderLineIds.has(it.lineItemId),
    );
    if (badLine) {
      res.status(400).json({ error: "Unknown line item" });
      return;
    }

    const items = body.items.map((it) => ({
      lineItemId: it.lineItemId ?? null,
      itemNumber: it.itemNumber ?? null,
      color: it.color ?? null,
      description: it.description ?? null,
      sizes: it.sizes.map((s) => ({ label: s.label, qty: Math.round(s.qty) })),
    }));
    const totalQty = items.reduce(
      (sum, it) => sum + it.sizes.reduce((s2, s) => s2 + s.qty, 0),
      0,
    );

    const inserted = await db
      .insert(reorderRequestsTable)
      .values({
        orderId: order[0].id,
        // Trust the snapshot over the client for order identity fields.
        visualId: order[0].visualId ?? body.visualId ?? null,
        orderNickname: order[0].nickname ?? body.orderNickname ?? null,
        customerName: body.customerName.trim(),
        customerEmail: body.customerEmail.trim().toLowerCase(),
        customerCompany: body.customerCompany?.trim() || null,
        notes: body.notes?.trim() || null,
        items,
        totalQty,
      })
      .returning({ id: reorderRequestsTable.id });
    const id = inserted[0].id;

    const emailSent = await sendReorderRequestEmail(
      {
        requestId: id,
        orderId: order[0].id,
        visualId: order[0].visualId ?? null,
        orderNickname: order[0].nickname ?? null,
        customerName: body.customerName.trim(),
        customerEmail: body.customerEmail.trim().toLowerCase(),
        customerCompany: body.customerCompany?.trim() || null,
        notes: body.notes?.trim() || null,
        items,
        totalQty,
      },
      req.log,
    );
    if (emailSent) {
      await db
        .update(reorderRequestsTable)
        .set({ emailSent: true })
        .where(eq(reorderRequestsTable.id, id));
    }

    res.status(201).json({ ok: true, id });
  } catch (err) {
    req.log.error({ err }, "Reorder request submit failed");
    res.status(500).json({ error: "Failed to submit request" });
  }
});

export default router;
