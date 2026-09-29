import { Router, type IRouter } from "express";
import categoryReviewRouter from "./chipplyCategoryReview";
import {
  db,
  pool,
  chipplyStoresTable,
  chipplyStoreStylesTable,
} from "@workspace/db";
import { eq, desc, asc, and, ne, isNotNull } from "drizzle-orm";
import { parseChipplyEmail, isEmptyParse } from "../lib/chipply/parseEmail";
import {
  parseCsvRows,
  detectCsvKind,
  parseSalesReportCsv,
  parseMarginReportCsv,
} from "../lib/chipply/parseCsv";
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
router.use(categoryReviewRouter);

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

export function storeJson(s: StoreRow, companies: Map<string, string>) {
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
    salesperson: s.salesperson,
    organizationName: s.organizationName,
    openedAt: s.openedAt,
    orgFee: s.orgFee,
    productCost: s.productCost,
    productPrice: s.productPrice,
    processPrice: s.processPrice,
    combinedPrice: s.combinedPrice,
    optionFees: s.optionFees,
    sizeUpcharges: s.sizeUpcharges,
    tax: s.tax,
    shipping: s.shipping,
    handlingFee: s.handlingFee,
    manualAdjustment: s.manualAdjustment,
    orderTotal: s.orderTotal,
    paymentCard: s.paymentCard,
    paymentKlarna: s.paymentKlarna,
    paymentEcert: s.paymentEcert,
    paymentPo: s.paymentPo,
    paymentPromo: s.paymentPromo,
    chipplyFee: s.chipplyFee,
    ccProcessingFee: s.ccProcessingFee,
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

/** Like moneyToDb but allows negatives (manual adjustments can be credits). */
function signedMoneyToDb(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < -10_000_000 ||
    v > 10_000_000
  ) {
    throw new Error("Money values must be finite numbers");
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
  if (body.financials !== undefined && body.financials !== null) {
    if (typeof body.financials !== "object") {
      throw new Error("financials must be an object");
    }
    Object.assign(
      out,
      readFinancialFields(body.financials as Record<string, unknown>),
    );
  }
  return out;
}

/**
 * SalesReport CSV financial columns (nested under `financials` in
 * create/patch bodies). All optional; only supplied keys are written.
 */
function readFinancialFields(fin: Record<string, unknown>) {
  const out: Partial<typeof chipplyStoresTable.$inferInsert> = {};
  const salesperson = textField(fin.salesperson, 200);
  if (salesperson !== undefined) out.salesperson = salesperson;
  const organizationName = textField(fin.organizationName, 200);
  if (organizationName !== undefined) out.organizationName = organizationName;
  const openedAt = textField(fin.openedAt, 10);
  if (openedAt !== undefined) {
    if (openedAt !== null && !DATE_RE.test(openedAt)) {
      throw new Error("openedAt must be YYYY-MM-DD");
    }
    out.openedAt = openedAt;
  }
  const moneyCols = [
    "orgFee",
    "productCost",
    "productPrice",
    "processPrice",
    "combinedPrice",
    "optionFees",
    "sizeUpcharges",
    "tax",
    "shipping",
    "handlingFee",
    "orderTotal",
    "paymentCard",
    "paymentKlarna",
    "paymentEcert",
    "paymentPo",
    "paymentPromo",
    "chipplyFee",
    "ccProcessingFee",
  ] as const;
  for (const col of moneyCols) {
    const v = moneyToDb(fin[col]);
    if (v !== undefined) out[col] = v;
  }
  // Manual adjustment is the one field that can be negative (a credit).
  const manualAdjustment = signedMoneyToDb(fin.manualAdjustment);
  if (manualAdjustment !== undefined) out.manualAdjustment = manualAdjustment;
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

// ── Parse uploaded CSV export (no write) ────────────────────────────

const numOrNull = (v: string | null): number | null =>
  v == null ? null : Number(v);

router.post("/chipply/parse-file", async (req, res) => {
  const fileText =
    typeof req.body?.fileText === "string" ? req.body.fileText : "";
  if (fileText.trim().length < 10 || fileText.length > 200000) {
    res.status(400).json({ error: "Upload a Chipply CSV export (10-200000 chars)" });
    return;
  }
  try {
    const headerRow = parseCsvRows(fileText)[0] ?? [];
    const kind = detectCsvKind(headerRow);
    if (kind === "unknown") {
      res.status(400).json({
        error:
          "That file doesn't look like a Chipply SalesReport or Margin Report CSV export",
      });
      return;
    }

    if (kind === "margin_report") {
      const rows = parseMarginReportCsv(fileText);
      if (rows.length === 0) {
        res.status(400).json({ error: "No style rows found in that Margin Report" });
        return;
      }
      res.json({
        kind,
        salesReport: null,
        namedRowCount: 0,
        marginRows: rows.map((r) => ({
          vendorName: r.vendorName,
          style: r.style,
          productName: r.productName,
          purchases: r.purchases,
          totalSale: numOrNull(r.totalSale),
          totalCost: numOrNull(r.totalCost),
          totalProfit: numOrNull(r.totalProfit),
        })),
        candidates: [],
        existingStore: null,
      });
      return;
    }

    const { parsed, namedRowCount } = parseSalesReportCsv(fileText);
    if (!parsed || !parsed.storeName) {
      res.status(400).json({ error: "No store row found in that SalesReport" });
      return;
    }

    const candidates = await findCandidates(parsed.storeName);

    // Duplicate check — the CSV carries the real event id, so prefer an
    // exact event-id match, then fall back to normalized store name.
    let existing: StoreRow | null = null;
    const stores = await db
      .select()
      .from(chipplyStoresTable)
      .where(eq(chipplyStoresTable.archived, false));
    existing =
      (parsed.eventId
        ? stores.find((s) => s.eventId === parsed.eventId)
        : undefined) ??
      stores.find(
        (s) =>
          parsed.storeName &&
          normalizeName(s.storeName) === normalizeName(parsed.storeName),
      ) ??
      null;

    const companies = await customerCompanies([existing?.pvCustomerId ?? null]);
    res.json({
      kind,
      salesReport: {
        storeName: parsed.storeName,
        eventId: parsed.eventId,
        openedAt: parsed.openedAt,
        closedAt: parsed.closedAt,
        salesperson: parsed.salesperson,
        organizationName: parsed.organizationName,
        orgFee: numOrNull(parsed.orgFee),
        productCost: numOrNull(parsed.productCost),
        productPrice: numOrNull(parsed.productPrice),
        processPrice: numOrNull(parsed.processPrice),
        combinedPrice: numOrNull(parsed.combinedPrice),
        optionFees: numOrNull(parsed.optionFees),
        sizeUpcharges: numOrNull(parsed.sizeUpcharges),
        fundraising: numOrNull(parsed.fundraising),
        tax: numOrNull(parsed.tax),
        shipping: numOrNull(parsed.shipping),
        handlingFee: numOrNull(parsed.handlingFee),
        manualAdjustment: numOrNull(parsed.manualAdjustment),
        orderTotal: numOrNull(parsed.orderTotal),
        paymentCard: numOrNull(parsed.paymentCard),
        paymentKlarna: numOrNull(parsed.paymentKlarna),
        paymentEcert: numOrNull(parsed.paymentEcert),
        paymentPo: numOrNull(parsed.paymentPo),
        paymentPromo: numOrNull(parsed.paymentPromo),
        chipplyFee: numOrNull(parsed.chipplyFee),
        ccProcessingFee: numOrNull(parsed.ccProcessingFee),
        totalDollarsGuess: numOrNull(parsed.totalDollarsGuess),
      },
      namedRowCount,
      marginRows: null,
      candidates,
      existingStore: existing ? storeJson(existing, companies) : null,
    });
  } catch (err) {
    req.log.error({ err }, "chipply parse-file failed");
    res.status(500).json({ error: "Failed to parse file" });
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
    const [companies, invoices, styles, marginRows] = await Promise.all([
      customerCompanies([store.pvCustomerId]),
      store.eventId ? listLinkedInvoices(store.eventId) : Promise.resolve([]),
      store.eventId ? aggregateStyles(store.eventId) : Promise.resolve([]),
      db
        .select()
        .from(chipplyStoreStylesTable)
        .where(eq(chipplyStoreStylesTable.storeId, id))
        .orderBy(asc(chipplyStoreStylesTable.vendorName), asc(chipplyStoreStylesTable.style)),
    ]);
    res.json({
      store: storeJson(store, companies),
      invoices,
      styles,
      marginStyles: marginRows.map(styleJson),
    });
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

// ── Margin-report style rows (replace-on-reimport) ──────────────────

type StyleRow = typeof chipplyStoreStylesTable.$inferSelect;

function styleJson(r: StyleRow) {
  return {
    id: r.id,
    vendorName: r.vendorName,
    style: r.style,
    productName: r.productName,
    purchases: r.purchases,
    totalSale: r.totalSale,
    totalCost: r.totalCost,
    totalProfit: r.totalProfit,
    createdAt: r.createdAt.toISOString(),
  };
}

router.post("/chipply/stores/:id/styles", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Store not found" });
    return;
  }
  const rowsRaw = req.body?.rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0 || rowsRaw.length > 1000) {
    res.status(400).json({ error: "rows must be a non-empty array (max 1000)" });
    return;
  }
  let values: (typeof chipplyStoreStylesTable.$inferInsert)[];
  try {
    values = rowsRaw.map((raw: unknown) => {
      if (typeof raw !== "object" || raw === null) {
        throw new Error("Each row must be an object");
      }
      const r = raw as Record<string, unknown>;
      const row: typeof chipplyStoreStylesTable.$inferInsert = {
        storeId: id,
        vendorName: textField(r.vendorName, 200) ?? null,
        style: textField(r.style, 100) ?? null,
        productName: textField(r.productName, 300) ?? null,
        purchases: intField(r.purchases) ?? null,
        // Sale/cost can't be negative; profit can (sold below cost).
        totalSale: moneyToDb(r.totalSale) ?? null,
        totalCost: moneyToDb(r.totalCost) ?? null,
        totalProfit: signedMoneyToDb(r.totalProfit) ?? null,
      };
      if (!row.vendorName && !row.style && !row.productName) {
        throw new Error("Each row needs a vendor, style, or product name");
      }
      return row;
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid rows" });
    return;
  }
  try {
    const [store] = await db
      .select({ id: chipplyStoresTable.id })
      .from(chipplyStoresTable)
      .where(eq(chipplyStoresTable.id, id))
      .limit(1);
    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }
    // Full-snapshot semantics: the export is the complete style list, so
    // replace everything in one transaction.
    const inserted = await db.transaction(async (tx) => {
      await tx
        .delete(chipplyStoreStylesTable)
        .where(eq(chipplyStoreStylesTable.storeId, id));
      return tx.insert(chipplyStoreStylesTable).values(values).returning();
    });
    inserted.sort(
      (a, b) =>
        (a.vendorName ?? "").localeCompare(b.vendorName ?? "") ||
        (a.style ?? "").localeCompare(b.style ?? ""),
    );
    res.json({ styles: inserted.map(styleJson) });
  } catch (err) {
    req.log.error({ err }, "replace chipply store styles failed");
    res.status(500).json({ error: "Failed to save margin rows" });
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
