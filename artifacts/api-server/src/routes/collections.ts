import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCollectionBody,
  UpdateCollectionBody,
  AddCollectionItemsBody,
  UpdateCollectionItemBody,
} from "@workspace/api-zod";
import {
  db,
  collectionsTable,
  collectionItemsTable,
  catalogProductsTable,
  pvCustomersTable,
  type Collection,
} from "@workspace/db";
import { and, desc, eq, sql, inArray } from "drizzle-orm";

/**
 * Curation collections (Product Finder phase 3).
 * Hub-owned data; the optional customer link is a plain Printavo customer id
 * (no FK into the synced mirror tables — sync owns their lifecycle).
 * Item display data is joined live from the local catalog so collections
 * never go stale when the catalog refreshes.
 */

const router: IRouter = Router();

/** Same display-name rule as the customer directory routes. */
const CUSTOMER_NAME_SQL = sql<string | null>`COALESCE(
  NULLIF(${pvCustomersTable.companyName}, ''),
  ${pvCustomersTable.data} -> 'primaryContact' ->> 'fullName'
)`;

async function customerName(printavoCustomerId: string | null): Promise<string | null> {
  if (!printavoCustomerId) return null;
  const [row] = await db
    .select({ name: CUSTOMER_NAME_SQL })
    .from(pvCustomersTable)
    .where(eq(pvCustomersTable.printavoId, printavoCustomerId))
    .limit(1);
  return row?.name ?? null;
}

async function loadDetail(id: string): Promise<Record<string, unknown> | null> {
  const [coll] = await db
    .select()
    .from(collectionsTable)
    .where(eq(collectionsTable.id, id))
    .limit(1);
  if (!coll) return null;

  const items = await db
    .select({
      id: collectionItemsTable.id,
      vendor: collectionItemsTable.vendor,
      styleName: collectionItemsTable.styleName,
      colors: collectionItemsTable.colors,
      note: collectionItemsTable.note,
      createdAt: collectionItemsTable.createdAt,
      brand: catalogProductsTable.brand,
      title: catalogProductsTable.title,
      styleImage: catalogProductsTable.styleImage,
      priceMin: catalogProductsTable.priceMin,
      priceMax: catalogProductsTable.priceMax,
      discontinued: catalogProductsTable.discontinued,
      catalogId: catalogProductsTable.id,
    })
    .from(collectionItemsTable)
    .leftJoin(
      catalogProductsTable,
      and(
        eq(catalogProductsTable.vendor, collectionItemsTable.vendor),
        eq(catalogProductsTable.styleName, collectionItemsTable.styleName),
      ),
    )
    .where(eq(collectionItemsTable.collectionId, id))
    .orderBy(collectionItemsTable.createdAt);

  return {
    id: coll.id,
    name: coll.name,
    printavoCustomerId: coll.printavoCustomerId,
    customerName: await customerName(coll.printavoCustomerId),
    notes: coll.notes,
    createdByEmail: coll.createdByEmail,
    createdAt: coll.createdAt.toISOString(),
    updatedAt: coll.updatedAt.toISOString(),
    items: items.map((it) => ({
      id: it.id,
      vendor: it.vendor,
      styleName: it.styleName,
      colors: it.colors,
      note: it.note,
      brand: it.brand,
      title: it.title,
      styleImage: it.styleImage,
      priceMin: it.priceMin != null ? Number(it.priceMin) : null,
      priceMax: it.priceMax != null ? Number(it.priceMax) : null,
      discontinued: it.discontinued ?? false,
      inCatalog: it.catalogId != null,
      createdAt: it.createdAt.toISOString(),
    })),
  };
}

function sendDetail(res: Response, detail: Record<string, unknown> | null): void {
  if (!detail) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }
  res.json(detail);
}

type NewItem = {
  vendor: "sanmar" | "ss";
  styleName: string;
  colors?: string[] | undefined;
  note?: string | null | undefined;
};

/** Insert items, merging into existing (colors unioned; note kept unless new). */
async function mergeItems(collectionId: string, items: NewItem[]): Promise<void> {
  if (items.length === 0) return;
  const existing = await db
    .select()
    .from(collectionItemsTable)
    .where(eq(collectionItemsTable.collectionId, collectionId));
  const byKey = new Map(existing.map((e) => [`${e.vendor}|${e.styleName}`, e]));

  // Group the incoming batch by (vendor, style) first — a "Save All" batch can
  // legitimately contain the same style twice (e.g. two chosen colors).
  const grouped = new Map<string, NewItem>();
  for (const item of items) {
    const styleName = item.styleName.trim();
    if (!styleName) continue;
    const key = `${item.vendor}|${styleName}`;
    const prev = grouped.get(key);
    if (prev) {
      prev.colors = [...(prev.colors ?? []), ...(item.colors ?? [])];
      if (item.note !== undefined && item.note !== null && item.note.trim() !== "") prev.note = item.note;
    } else {
      grouped.set(key, { ...item, styleName, colors: [...(item.colors ?? [])] });
    }
  }

  for (const item of grouped.values()) {
    const styleName = item.styleName;
    const colors = Array.from(new Set((item.colors ?? []).map((c) => c.trim()).filter(Boolean)));
    const prev = byKey.get(`${item.vendor}|${styleName}`);
    if (prev) {
      await db
        .update(collectionItemsTable)
        .set({
          colors: Array.from(new Set([...prev.colors, ...colors])),
          note: item.note !== undefined && item.note !== null && item.note.trim() !== "" ? item.note : prev.note,
        })
        .where(eq(collectionItemsTable.id, prev.id));
    } else {
      await db.insert(collectionItemsTable).values({
        collectionId,
        vendor: item.vendor,
        styleName,
        colors,
        note: item.note ?? null,
      });
    }
  }
  await touch(collectionId);
}

async function touch(collectionId: string): Promise<void> {
  await db
    .update(collectionsTable)
    .set({ updatedAt: new Date() })
    .where(eq(collectionsTable.id, collectionId));
}

router.get("/collections", (req, res) => {
  const customerId =
    typeof req.query.customerId === "string" && req.query.customerId.trim() !== ""
      ? req.query.customerId.trim()
      : null;
  (async () => {
    const colls: Collection[] = await db
      .select()
      .from(collectionsTable)
      .where(customerId ? eq(collectionsTable.printavoCustomerId, customerId) : undefined)
      .orderBy(desc(collectionsTable.updatedAt));

    const ids = colls.map((c) => c.id);
    const counts = new Map<string, number>();
    const previews = new Map<string, string[]>();
    if (ids.length > 0) {
      const rows = await db
        .select({
          collectionId: collectionItemsTable.collectionId,
          styleImage: catalogProductsTable.styleImage,
        })
        .from(collectionItemsTable)
        .leftJoin(
          catalogProductsTable,
          and(
            eq(catalogProductsTable.vendor, collectionItemsTable.vendor),
            eq(catalogProductsTable.styleName, collectionItemsTable.styleName),
          ),
        )
        .where(inArray(collectionItemsTable.collectionId, ids))
        .orderBy(collectionItemsTable.createdAt);
      for (const r of rows) {
        counts.set(r.collectionId, (counts.get(r.collectionId) ?? 0) + 1);
        if (r.styleImage) {
          const list = previews.get(r.collectionId) ?? [];
          if (list.length < 4) {
            list.push(r.styleImage);
            previews.set(r.collectionId, list);
          }
        }
      }
    }

    // Resolve customer names in one query.
    const custIds = Array.from(
      new Set(colls.map((c) => c.printavoCustomerId).filter((x): x is string => !!x)),
    );
    const nameMap = new Map<string, string | null>();
    if (custIds.length > 0) {
      const rows = await db
        .select({ id: pvCustomersTable.printavoId, name: CUSTOMER_NAME_SQL })
        .from(pvCustomersTable)
        .where(inArray(pvCustomersTable.printavoId, custIds));
      for (const r of rows) nameMap.set(r.id, r.name);
    }

    return colls.map((c) => ({
      id: c.id,
      name: c.name,
      printavoCustomerId: c.printavoCustomerId,
      customerName: c.printavoCustomerId ? (nameMap.get(c.printavoCustomerId) ?? null) : null,
      notes: c.notes,
      createdByEmail: c.createdByEmail,
      itemCount: counts.get(c.id) ?? 0,
      previewImages: previews.get(c.id) ?? [],
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  })()
    .then((collections) => res.json({ collections }))
    .catch((err) => {
      req.log.error({ err }, "Collection list failed");
      res.status(500).json({ error: "Failed to list collections" });
    });
});

router.post("/collections", (req: Request, res) => {
  const parsed = CreateCollectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid collection payload" });
    return;
  }
  (async () => {
    const [created] = await db
      .insert(collectionsTable)
      .values({
        name: parsed.data.name.trim(),
        printavoCustomerId: parsed.data.printavoCustomerId ?? null,
        notes: parsed.data.notes ?? null,
        createdByEmail: req.staff?.email ?? null,
      })
      .returning();
    await mergeItems(created!.id, (parsed.data.items ?? []) as NewItem[]);
    return loadDetail(created!.id);
  })()
    .then((detail) => res.status(201).json(detail))
    .catch((err) => {
      req.log.error({ err }, "Collection create failed");
      res.status(500).json({ error: "Failed to create collection" });
    });
});

router.get("/collections/:id", (req, res) => {
  loadDetail(req.params.id)
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection fetch failed");
      res.status(500).json({ error: "Failed to fetch collection" });
    });
});

router.patch("/collections/:id", (req, res) => {
  const parsed = UpdateCollectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid collection update" });
    return;
  }
  const set: Partial<typeof collectionsTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) set.name = parsed.data.name.trim();
  if ("printavoCustomerId" in req.body) set.printavoCustomerId = parsed.data.printavoCustomerId ?? null;
  if ("notes" in req.body) set.notes = parsed.data.notes ?? null;
  (async () => {
    const updated = await db
      .update(collectionsTable)
      .set(set)
      .where(eq(collectionsTable.id, req.params.id))
      .returning({ id: collectionsTable.id });
    if (updated.length === 0) return null;
    return loadDetail(req.params.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection update failed");
      res.status(500).json({ error: "Failed to update collection" });
    });
});

router.delete("/collections/:id", (req, res) => {
  db.delete(collectionsTable)
    .where(eq(collectionsTable.id, req.params.id))
    .returning({ id: collectionsTable.id })
    .then((rows) => {
      if (rows.length === 0) {
        res.status(404).json({ error: "Collection not found" });
        return;
      }
      res.json({ ok: true });
    })
    .catch((err) => {
      req.log.error({ err }, "Collection delete failed");
      res.status(500).json({ error: "Failed to delete collection" });
    });
});

router.post("/collections/:id/items", (req, res) => {
  const parsed = AddCollectionItemsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid items payload" });
    return;
  }
  (async () => {
    const [coll] = await db
      .select({ id: collectionsTable.id })
      .from(collectionsTable)
      .where(eq(collectionsTable.id, req.params.id))
      .limit(1);
    if (!coll) return null;
    await mergeItems(coll.id, parsed.data.items as NewItem[]);
    return loadDetail(coll.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection item add failed");
      res.status(500).json({ error: "Failed to add items" });
    });
});

router.patch("/collections/:id/items/:itemId", (req, res) => {
  const parsed = UpdateCollectionItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid item update" });
    return;
  }
  const set: Partial<typeof collectionItemsTable.$inferInsert> = {};
  if (parsed.data.colors !== undefined) {
    set.colors = Array.from(new Set(parsed.data.colors.map((c: string) => c.trim()).filter(Boolean)));
  }
  if ("note" in req.body) set.note = parsed.data.note ?? null;
  (async () => {
    const updated = await db
      .update(collectionItemsTable)
      .set(set)
      .where(
        and(
          eq(collectionItemsTable.id, req.params.itemId),
          eq(collectionItemsTable.collectionId, req.params.id),
        ),
      )
      .returning({ id: collectionItemsTable.id });
    if (updated.length === 0) return null;
    await touch(req.params.id);
    return loadDetail(req.params.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection item update failed");
      res.status(500).json({ error: "Failed to update item" });
    });
});

router.delete("/collections/:id/items/:itemId", (req, res) => {
  (async () => {
    const deleted = await db
      .delete(collectionItemsTable)
      .where(
        and(
          eq(collectionItemsTable.id, req.params.itemId),
          eq(collectionItemsTable.collectionId, req.params.id),
        ),
      )
      .returning({ id: collectionItemsTable.id });
    if (deleted.length === 0) return null;
    await touch(req.params.id);
    return loadDetail(req.params.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection item delete failed");
      res.status(500).json({ error: "Failed to remove item" });
    });
});

export default router;
