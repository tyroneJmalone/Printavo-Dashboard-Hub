import { Router, type IRouter } from "express";
import { db, pool, chipplyStoresTable } from "@workspace/db";
import { eq, desc, and, ne, isNotNull } from "drizzle-orm";
import { parseChipplyEmail, isEmptyParse } from "../lib/chipply/parseEmail";
import {
  findCandidates,
  listDetectedGroups,
  listLinkedInvoices,
  aggregateStyles,
  countLinkedInvoices,
  normalizeName,
} from "../lib/chipply/matching";

/**
 * Chipply web stores — imported via pasted "Web Store Closed" emails
 * (Chipply has no open API). Chipply dollars live ONLY in chipply_stores
 * and are never mixed into Printavo invoice revenue. Printavo invoice
 * links are derived live from the nickname prefix convention — see
 * lib/chipply/matching.ts.
 *
 * Mounted behind requireStaff.
 */

const router: IRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_RE = /^\d{5,7}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type StoreRow = typeof chipplyStoresTable.$inferSelect;

async function customerCompanies(
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return map;
  const r = await pool.query(
    `SELECT printavo_id, company_name FROM pv_customers WHERE printavo_id = ANY($1)`,
    [wanted],
  );
  for (const row of r.rows) {
    map.set(row.printavo_id as string, (row.company_name ?? "") as string);
  }
  return map;
}

function storeJson(s: StoreRow, companies: Map<string, string>) {
  return {
    id: s.id,
    eventId: s.eventId,
    storeName: s.storeName,
    orgContact: s.orgContact,
    storeAdmin: s.storeAdmin,
    closedAt: s.closedAt,
    numOrders: s.numOrders,
    numProducts: s.numProducts,
    totalDollars: s.totalDollars,
    fundraising: s.fundraising,
    pvCustomerId: s.pvCustomerId,
    pvCustomerCompany: s.pvCustomerId
      ? (companies.get(s.pvCustomerId) ?? null)
      : null,
    notes: s.notes,
    archived: s.archived,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function moneyToDb(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000_000) {
    throw new Error("Money values must be non-negative numbers");
  }
  return v.toFixed(2);
}

function intField(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1_000_000) {
    throw new Error("Counts must be non-negative integers");
  }
  return v as number;
}

function textField(v: unknown, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new Error("Expected a string");
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw new Error(`Text too long (max ${max})`);
  return t;
}

/** Shared body → column mapping for create/patch. Throws on bad input. */
function readStoreFields(body: Record<string, unknown>) {
  const out: Partial<typeof chipplyStoresTable.$inferInsert> = {};
  const eventId = textField(body.eventId, 10);
  if (eventId !== undefined) {
    if (eventId !== null && !EVENT_ID_RE.test(eventId)) {
      throw new Error("eventId must be a 5-7 digit Chipply event number");
    }
    out.eventId = eventId;
  }
  const closedAt = textField(body.closedAt, 10);
  if (closedAt !== undefined) {
    if (closedAt !== null && !DATE_RE.test(closedAt)) {
      throw new Error("closedAt must be YYYY-MM-DD");
    }
    out.closedAt = closedAt;
  }
  const orgContact = textField(body.orgContact, 200);
  if (orgContact !== undefined) out.orgContact = orgContact;
  const storeAdmin = textField(body.storeAdmin, 200);
  if (storeAdmin !== undefined) out.storeAdmin = storeAdmin;
  const notes = textField(body.notes, 2000);
  if (notes !== undefined) out.notes = notes;
  const pvCustomerId = textField(body.pvCustomerId, 30);
  if (pvCustomerId !== undefined) out.pvCustomerId = pvCustomerId;
  const numOrders = intField(body.numOrders);
  if (numOrders !== undefined) out.numOrders = numOrders;
  const numProducts = intField(body.numProducts);
  if (numProducts !== undefined) out.numProducts = numProducts;
  const totalDollars = moneyToDb(body.totalDollars);
  if (totalDollars !== undefined) out.totalDollars = totalDollars;
  const fundraising = moneyToDb(body.fundraising);
  if (fundraising !== undefined) out.fundraising = fundraising;
  return out;
}

// ── Parse email (no write) ──────────────────────────────────────────

router.post("/chipply/parse-email", async (req, res) => {
  const emailText =
    typeof req.body?.emailText === "string" ? req.body.emailText : "";
  if (emailText.trim().length < 10 || emailText.length > 20000) {
    res.status(400).json({ error: "Paste the store-closed email text (10-20000 chars)" });
    return;
  }
  try {
    const parsed = parseChipplyEmail(emailText);
    if (isEmptyParse(parsed)) {
      res.status(400).json({
        error:
          "Couldn't find any Chipply store fields in that text — paste the full store-closed email body",
      });
      return;
    }
    const candidates = parsed.storeName
      ? await findCandidates(parsed.storeName)
      : [];

    // Duplicate check: an already-imported store matching a candidate event
    // id, or the same normalized store name.
    let existing: StoreRow | null = null;
    const candidateIds = candidates.map((c) => c.eventId);
    const stores = await db
      .select()
      .from(chipplyStoresTable)
      .where(eq(chipplyStoresTable.archived, false));
    existing =
      stores.find((s) => s.eventId && candidateIds.includes(s.eventId)) ??
      stores.find(
        (s) =>
          parsed.storeName &&
          normalizeName(s.storeName) === normalizeName(parsed.storeName),
      ) ??
      null;

    const companies = await customerCompanies([existing?.pvCustomerId ?? null]);
    res.json({
      parsed,
      candidates,
      existingStore: existing ? storeJson(existing, companies) : null,
    });
  } catch (err) {
    req.log.error({ err }, "chipply parse-email failed");
    res.status(500).json({ error: "Failed to parse email" });
  }
});

// ── Stores CRUD ─────────────────────────────────────────────────────

router.get("/chipply/stores", async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === "true";
    const rows = await db
      .select()
      .from(chipplyStoresTable)
      .where(
        includeArchived ? undefined : eq(chipplyStoresTable.archived, false),
      )
      .orderBy(desc(chipplyStoresTable.createdAt));
    const [companies, counts] = await Promise.all([
      customerCompanies(rows.map((r) => r.pvCustomerId)),
      countLinkedInvoices(
        rows.map((r) => r.eventId).filter((v): v is string => !!v),
      ),
    ]);
    res.json({
      stores: rows.map((s) => ({
        store: storeJson(s, companies),
        linkedInvoiceCount: s.eventId ? (counts.get(s.eventId) ?? 0) : 0,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "list chipply stores failed");
    res.status(500).json({ error: "Failed to load stores" });
  }
});

router.post("/chipply/stores", async (req, res) => {
  const storeName =
    typeof req.body?.storeName === "string" ? req.body.storeName.trim() : "";
  if (!storeName || storeName.length > 200) {
    res.status(400).json({ error: "Store name is required (max 200 chars)" });
    return;
  }
  let fields: Partial<typeof chipplyStoresTable.$inferInsert>;
  try {
    fields = readStoreFields(req.body ?? {});
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid store" });
    return;
  }
  const rawSource =
    typeof req.body?.rawSource === "string" && req.body.rawSource.trim()
      ? req.body.rawSource.slice(0, 20000)
      : null;
  try {
    if (fields.eventId) {
      const [dupe] = await db
        .select({ id: chipplyStoresTable.id })
        .from(chipplyStoresTable)
        .where(eq(chipplyStoresTable.eventId, fields.eventId))
        .limit(1);
      if (dupe) {
        res.status(409).json({
          error: `A store with Chipply event id ${fields.eventId} already exists — open it and update instead`,
        });
        return;
      }
    }
    const [created] = await db
      .insert(chipplyStoresTable)
      .values({ ...fields, storeName, rawSource })
      .returning();
    const companies = await customerCompanies([created.pvCustomerId]);
    res.status(201).json({ store: storeJson(created, companies) });
  } catch (err) {
    req.log.error({ err }, "create chipply store failed");
    res.status(500).json({ error: "Failed to create store" });
  }
});

router.get("/chipply/stores/:id", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Store not found" });
    return;
  }
  try {
    const [store] = await db
      .select()
      .from(chipplyStoresTable)
      .where(eq(chipplyStoresTable.id, id))
      .limit(1);
    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }
    const [companies, invoices, styles] = await Promise.all([
      customerCompanies([store.pvCustomerId]),
      store.eventId ? listLinkedInvoices(store.eventId) : Promise.resolve([]),
      store.eventId ? aggregateStyles(store.eventId) : Promise.resolve([]),
    ]);
    res.json({ store: storeJson(store, companies), invoices, styles });
  } catch (err) {
    req.log.error({ err }, "get chipply store failed");
    res.status(500).json({ error: "Failed to load store" });
  }
});

router.patch("/chipply/stores/:id", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Store not found" });
    return;
  }
  const updates: Partial<typeof chipplyStoresTable.$inferInsert> = {};
  try {
    Object.assign(updates, readStoreFields(req.body ?? {}));
    if (req.body?.storeName !== undefined) {
      const name =
        typeof req.body.storeName === "string" ? req.body.storeName.trim() : "";
      if (!name || name.length > 200) {
        throw new Error("Store name must be 1-200 chars");
      }
      updates.storeName = name;
    }
    if (req.body?.archived !== undefined) {
      if (typeof req.body.archived !== "boolean") {
        throw new Error("archived must be a boolean");
      }
      updates.archived = req.body.archived;
    }
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid update" });
    return;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  try {
    if (updates.eventId) {
      const [dupe] = await db
        .select({ id: chipplyStoresTable.id })
        .from(chipplyStoresTable)
        .where(
          and(
            eq(chipplyStoresTable.eventId, updates.eventId),
            ne(chipplyStoresTable.id, id),
            isNotNull(chipplyStoresTable.eventId),
          ),
        )
        .limit(1);
      if (dupe) {
        res.status(409).json({
          error: `Another store already uses Chipply event id ${updates.eventId}`,
        });
        return;
      }
    }
    updates.updatedAt = new Date();
    const [updated] = await db
      .update(chipplyStoresTable)
      .set(updates)
      .where(eq(chipplyStoresTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Store not found" });
      return;
    }
    const companies = await customerCompanies([updated.pvCustomerId]);
    res.json({ store: storeJson(updated, companies) });
  } catch (err) {
    req.log.error({ err }, "update chipply store failed");
    res.status(500).json({ error: "Failed to update store" });
  }
});

// ── Detected (live-derived, not yet imported) ───────────────────────

router.get("/chipply/detected", async (req, res) => {
  try {
    const detected = await listDetectedGroups();
    res.json({ detected });
  } catch (err) {
    req.log.error({ err }, "list detected chipply stores failed");
    res.status(500).json({ error: "Failed to scan for stores" });
  }
});

export default router;
