import { listExternalVendorOrders, importExternalVendorOrders, refreshExternalVendorOrder } from "../lib/purchasing/externalVendorTracking";
import { Router, type IRouter, type Response } from "express";
import { requireValidAdminPin } from "../lib/auth/adminPin";
import vendorShippingTermsRouter from "./vendorShippingTerms";
import { getCarrierTrackingSettings, setCarrierTrackingSettings, refreshCarrierTracking } from "../lib/purchasing/carrierTracking";
import {
  GetPurchasingApprovedMappingQueryParams,
  ApprovePurchasingMappingBody,
  VendorLookupBody,
  VendorInventoryBody,
  ProductSearchBody,
  GetFinderOrderQueryParams,
  CreatePoFileBody,
  UpdatePoFileBody,
  AppendPoLineItemsBody,
  SubmitPoToVendorBody,
  AdminUnlockPoFileBody,
  VendorSubmitBody,
  MarkVendorOrderFailedBody,
  SetCarrierTrackingSettingsBody,
  SetVendorShipToBody,
  CreateStatusRuleBody,
  UpdateStatusRuleBody,
  ReorderStatusRulesBody,
  CatalogSearchQueryParams,
  SetCatalogTagOverrideBody,
  SetCatalogColorFamilyBody,
  BulkSetLineItemProductStatusBody,
  BulkSetLineItemProductStatusResponse,
} from "@workspace/api-zod";
import { searchCatalog, catalogFilters } from "../lib/catalog/search";
import { catalogHealth, runCatalogRefresh, isRefreshActive } from "../lib/catalog/refresh";
import { normColorName } from "../lib/catalog/importers";
import { COLOR_FAMILIES } from "../lib/catalog/tagger";
import { db, catalogTagOverridesTable, catalogColorFamiliesTable, purchasingApprovedMappingsTable } from "@workspace/db";
import { normalizeMappingSource, verifiedMappingTarget } from "../lib/purchasing/approvedMappingPolicy";
import { sql, and, eq } from "drizzle-orm";
import { loadNeedsOrdering } from "../lib/purchasing/needsOrdering";
import { vendorLookup, VendorConfigError } from "../lib/purchasing/vendorLookup";
import { vendorInventory } from "../lib/purchasing/vendorInventory";
import { productSearch, loadOrderLineItems } from "../lib/purchasing/productFinder";
import {
  createPoFile,
  listPoFiles,
  getPoFile,
  updatePoFile,
  appendPoFileLineItems,
  unlockPoFile,
  adminUnlockVendorPoFile,
  deletePoFile,
  submitPoToVendor,
  type PoFileLineItem,
  type PoMutationResult,
} from "../lib/purchasing/poFiles";
import { submitVendorOrder, listVendorOrders } from "../lib/purchasing/vendorSubmit";
import {
  refreshVendorOrderStatus,
  refreshActiveVendorOrders,
  markVendorOrderFailed,
} from "../lib/purchasing/vendorTracking";
import {
  getVendorShipTo,
  setVendorShipTo,
  type VendorShipTo,
} from "../lib/purchasing/vendorSettings";
import { startPoPush } from "../lib/purchasing/poPush";
import { isPushActive } from "../lib/purchasing/pushRegistry";
import { renderPoHtml } from "../lib/purchasing/poHtml";
import {
  listStatusRules,
  createStatusRule,
  updateStatusRule,
  reorderStatusRules,
  deleteStatusRule,
  listPrintavoStatuses,
  listStatusSuggestions,
  evaluateRecentPushedOrders,
  applyStatusSuggestion,
  dismissStatusSuggestion,
  type StatusRuleInput,
} from "../lib/purchasing/statusRules";
import {
  bulkSetProductStatus,
  normalizeUniqueSelections,
} from "../lib/purchasing/lineItemProductStatus";

/**
 * Purchasing (Vendor Orders) module routes.
 * Phase 1: needs-ordering scan (Postgres only).
 * Phase 2: live vendor lookups (SanMar/S&S) + PO files.
 */

const router: IRouter = Router();
router.use(vendorShippingTermsRouter);

// Mounted behind requireStaff + moduleAccessGate, like all purchasing mutations.
router.get("/purchasing/approved-mapping", async (req, res) => {
  // Generated query schemas coerce strings; reject absent/repeated values first.
  if (["vendor", "sourceStyle", "sourceBrand", "sourceColor"].some((key) => typeof req.query[key] !== "string")) {
    res.status(400).json({ error: "Vendor, source style, brand and color are required query strings" });
    return;
  }
  const parsed = GetPurchasingApprovedMappingQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid purchasing mapping source context" });
    return;
  }
  const { vendor } = parsed.data;
  const sourceStyle = normalizeMappingSource(parsed.data.sourceStyle);
  const sourceBrand = normalizeMappingSource(parsed.data.sourceBrand);
  const sourceColor = normalizeMappingSource(parsed.data.sourceColor);
  if (!sourceStyle || !sourceColor) {
    res.status(400).json({ error: "Source style and color must not be blank" });
    return;
  }
  try {
    const t = purchasingApprovedMappingsTable;
    const [mapping] = await db.select({
      vendorStyleId: t.vendorStyleId, vendorStyle: t.vendorStyle, vendorColor: t.vendorColor,
    }).from(t).where(and(
      eq(t.vendor, vendor), eq(t.sourceStyle, sourceStyle),
      eq(t.sourceBrand, sourceBrand), eq(t.sourceColor, sourceColor),
    )).limit(1);
    res.json(mapping ?? null);
  } catch (err) {
    req.log.error({ err }, "Purchasing approval lookup failed");
    res.status(500).json({ error: "Could not load approved purchasing mapping" });
  }
});

router.put("/purchasing/approved-mapping", async (req, res) => {
  // No automatic learning: this endpoint is called only on explicit user approval.
  if (!req.staff) {
    res.status(401).json({ error: "Staff authentication required" });
    return;
  }
  const parsed = ApprovePurchasingMappingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid purchasing mapping approval" });
    return;
  }
  const input = parsed.data;
  const sourceStyle = normalizeMappingSource(input.sourceStyle);
  const sourceBrand = normalizeMappingSource(input.sourceBrand);
  const sourceColor = normalizeMappingSource(input.sourceColor);
  if (!sourceStyle || !sourceColor || !input.vendorStyle.trim() || !input.vendorColor.trim()) {
    res.status(400).json({ error: "Source and target style and color must not be blank" });
    return;
  }
  let target;
  try {
    // One existing bounded catalog lookup, no fuzzy auto-selection or vendor order calls.
    target = verifiedMappingTarget(input, await vendorLookup(input.vendor, input.vendorStyle));
  } catch (err) {
    req.log.error({ err }, "Purchasing approval vendor verification failed");
    res.status(503).json({ error: "Vendor catalog unavailable; approval was not saved. Try again." });
    return;
  }
  if (!target) {
    res.status(422).json({ error: "Selected vendor style and color could not be verified; approval was not saved." });
    return;
  }
  try {
    const t = purchasingApprovedMappingsTable;
    const approval = { ...target, approvedByEmail: req.staff.email, approvedAt: new Date() };
    await db.insert(t).values({
      vendor: input.vendor, sourceStyle, sourceBrand, sourceColor, ...approval,
    }).onConflictDoUpdate({
      target: [t.vendor, t.sourceStyle, t.sourceBrand, t.sourceColor],
      set: approval,
    });
    res.json(target);
  } catch (err) {
    req.log.error({ err }, "Purchasing approval save failed");
    res.status(500).json({ error: "Could not save approved purchasing mapping. Try again." });
  }
});

/** Postgres unique-constraint violation (code 23505), possibly wrapped. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (typeof e === "object" && e !== null) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

router.get("/purchasing/needs-ordering", (req, res) => {
  loadNeedsOrdering()
    .then((result) => res.json(result))
    .catch((err) => {
      req.log.error({ err }, "Needs-ordering scan failed");
      res.status(500).json({ error: "Needs-ordering scan failed" });
    });
});

router.post("/purchasing/line-item-product-status", async (req, res): Promise<void> => {
  const parsed = BulkSetLineItemProductStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid line-item product-status request" });
    return;
  }
  const normalized = normalizeUniqueSelections(parsed.data.lineItems);
  if (!normalized) {
    res.status(400).json({ error: "Line-item and order IDs must be non-empty and unique" });
    return;
  }

  try {
    const auditLog = req.log.child({ actor: req.staff!.email });
    const result = await bulkSetProductStatus(
      normalized,
      parsed.data.status,
      auditLog,
    );
    res.json(BulkSetLineItemProductStatusResponse.parse(result));
  } catch (err) {
    req.log.error({ err }, "Bulk line-item product-status update failed");
    res.status(500).json({ error: "Line-item product-status update failed" });
  }
});

router.post("/purchasing/product-search", (req, res) => {
  const parsed = ProductSearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid product-search request" });
    return;
  }
  productSearch(parsed.data.query)
    .then((result) => res.json(result))
    .catch((err) => {
      if (err instanceof VendorConfigError) {
        res.status(503).json({ error: err.message });
        return;
      }
      req.log.error({ err, query: parsed.data.query }, "Product search failed");
      res.status(503).json({ error: "Product search failed — vendor APIs may be temporarily unavailable" });
    });
});

router.get("/purchasing/finder-order", (req, res) => {
  const parsed = GetFinderOrderQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid visualId" });
    return;
  }
  loadOrderLineItems(parsed.data.visualId)
    .then((order) => {
      if (!order) {
        res.status(404).json({ error: `No synced order with visual ID ${parsed.data.visualId}` });
        return;
      }
      res.json(order);
    })
    .catch((err) => {
      req.log.error({ err, visualId: parsed.data.visualId }, "Finder order load failed");
      res.status(500).json({ error: "Order lookup failed" });
    });
});

router.get("/purchasing/catalog/search", (req, res) => {
  const parsed = CatalogSearchQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid catalog search query" });
    return;
  }
  searchCatalog({
    query: parsed.data.q,
    vendor: parsed.data.vendor,
    brand: parsed.data.brand,
    category: parsed.data.category,
    colorFamily: parsed.data.colorFamily,
    priceMin: parsed.data.priceMin,
    priceMax: parsed.data.priceMax,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  })
    .then((result) => res.json(result))
    .catch((err) => {
      req.log.error({ err, q: parsed.data.q }, "Catalog search failed");
      res.status(500).json({ error: "Catalog search failed" });
    });
});

router.get("/purchasing/catalog/filters", (req, res) => {
  catalogFilters()
    .then((f) => res.json(f))
    .catch((err) => {
      req.log.error({ err }, "Catalog filters load failed");
      res.status(500).json({ error: "Catalog filters load failed" });
    });
});

router.get("/purchasing/catalog/health", (req, res) => {
  catalogHealth()
    .then((h) => res.json(h))
    .catch((err) => {
      req.log.error({ err }, "Catalog health load failed");
      res.status(500).json({ error: "Catalog health load failed" });
    });
});

router.post("/purchasing/catalog/refresh", (req, res) => {
  if (isRefreshActive()) {
    res.json({ started: false });
    return;
  }
  // Fire and forget — progress is visible via the health endpoint.
  void runCatalogRefresh({ trigger: "manual" }, req.log).catch((err) => {
    req.log.error({ err }, "Manual catalog refresh failed");
  });
  res.json({ started: true });
});

router.post("/purchasing/catalog/tag-override", (req, res) => {
  const parsed = SetCatalogTagOverrideBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid tag override request" });
    return;
  }
  const { vendor, styleName } = parsed.data;
  const deltaAdd = Array.from(new Set(parsed.data.addTags.map((t) => t.toLowerCase().trim()).filter(Boolean)));
  const deltaRemove = Array.from(new Set(parsed.data.removeTags.map((t) => t.toLowerCase().trim()).filter(Boolean)));
  (async () => {
    // Merge the incoming DELTA with the stored override — each request is one
    // correction, not the full desired state. A tag added now leaves the
    // remove-list; a tag removed now leaves the add-list.
    const [existing] = await db
      .select()
      .from(catalogTagOverridesTable)
      .where(and(eq(catalogTagOverridesTable.vendor, vendor), eq(catalogTagOverridesTable.styleName, styleName)))
      .limit(1);
    const addSet = new Set(existing?.addTags ?? []);
    const removeSet = new Set(existing?.removeTags ?? []);
    for (const t of deltaAdd) {
      addSet.add(t);
      removeSet.delete(t);
    }
    for (const t of deltaRemove) {
      removeSet.add(t);
      addSet.delete(t);
    }
    const addTags = Array.from(addSet);
    const removeTags = Array.from(removeSet);
    await db
      .insert(catalogTagOverridesTable)
      .values({ vendor, styleName, addTags, removeTags, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [catalogTagOverridesTable.vendor, catalogTagOverridesTable.styleName],
        set: { addTags, removeTags, updatedAt: new Date() },
      });
    const arrayLit = (items: string[]) =>
      items.length === 0
        ? sql`'{}'::text[]`
        : sql`ARRAY[${sql.join(items.map((t) => sql`${t}`), sql`, `)}]::text[]`;
    const eff = (await db.execute(sql`
      SELECT COALESCE(array_agg(DISTINCT t), '{}'::text[]) AS tags FROM (
        SELECT unnest(p.tags) AS t FROM catalog_products p WHERE p.vendor = ${vendor} AND p.style_name = ${styleName}
        UNION SELECT unnest(${arrayLit(addTags)})
        EXCEPT SELECT unnest(${arrayLit(removeTags)})
      ) e
    `)) as unknown as { rows: { tags: string[] }[] };
    return eff.rows[0]?.tags ?? [];
  })()
    .then((effectiveTags) => res.json({ effectiveTags }))
    .catch((err) => {
      req.log.error({ err, vendor, styleName }, "Tag override save failed");
      res.status(500).json({ error: "Tag override save failed" });
    });
});

router.post("/purchasing/catalog/color-family", (req, res) => {
  const parsed = SetCatalogColorFamilyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid color family request" });
    return;
  }
  const families = Array.from(
    new Set(parsed.data.families.map((f) => f.toLowerCase().trim())),
  ).filter((f) => (COLOR_FAMILIES as readonly string[]).includes(f));
  if (parsed.data.families.length > 0 && families.length === 0) {
    res.status(400).json({ error: `Unknown color family — allowed: ${COLOR_FAMILIES.join(", ")}` });
    return;
  }
  const normName = normColorName(parsed.data.colorName);
  db.insert(catalogColorFamiliesTable)
    .values({ normName, colorName: parsed.data.colorName, families, source: "staff", updatedAt: new Date() })
    .onConflictDoUpdate({
      target: catalogColorFamiliesTable.normName,
      set: { families, source: "staff", updatedAt: new Date() },
    })
    .then(() => res.json({ ok: true }))
    .catch((err) => {
      req.log.error({ err, colorName: parsed.data.colorName }, "Color family save failed");
      res.status(500).json({ error: "Color family save failed" });
    });
});

router.post("/purchasing/vendor-lookup", (req, res) => {
  const parsed = VendorLookupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid vendor-lookup request" });
    return;
  }
  const { vendor, style, brandHint, descriptionHint } = parsed.data;
  vendorLookup(vendor, style, { brandHint, descriptionHint })
    .then((result) => res.json(result))
    .catch((err) => {
      if (err instanceof VendorConfigError) {
        res.status(503).json({ error: err.message });
        return;
      }
      req.log.error({ err, vendor, style }, "Vendor lookup failed");
      res.status(503).json({
        error: `${vendor === "sanmar" ? "SanMar" : "S&S Activewear"} lookup failed — vendor API may be temporarily unavailable`,
      });
    });
});

router.post("/purchasing/vendor-inventory", (req, res) => {
  const parsed = VendorInventoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid vendor-inventory request" });
    return;
  }
  const { vendor, style, styleId, catalogColor, sizes } = parsed.data;
  vendorInventory(vendor, style, catalogColor, sizes, styleId ?? null)
    .then((result) => res.json(result))
    .catch((err) => {
      if (err instanceof VendorConfigError) {
        res.status(503).json({ error: err.message });
        return;
      }
      req.log.error({ err, vendor, style, catalogColor }, "Vendor inventory failed");
      res.status(503).json({
        error: `${vendor === "sanmar" ? "SanMar" : "S&S Activewear"} inventory check failed — vendor API may be temporarily unavailable`,
      });
    });
});

router.get("/purchasing/po-files", (req, res) => {
  listPoFiles()
    .then((poFiles) => res.json({ poFiles }))
    .catch((err) => {
      req.log.error({ err }, "PO file list failed");
      res.status(500).json({ error: "Failed to list PO files" });
    });
});

router.post("/purchasing/po-files", (req, res) => {
  const parsed = CreatePoFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid PO payload" });
    return;
  }
  createPoFile({
    poNumber: parsed.data.poNumber,
    vendorName: parsed.data.vendorName,
    notes: parsed.data.notes ?? null,
    lineItems: parsed.data.lineItems as PoFileLineItem[],
  })
    .then((po) => res.status(201).json(po))
    .catch((err) => {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "That PO number is already in use" });
        return;
      }
      req.log.error({ err }, "PO file create failed");
      res.status(500).json({ error: "Failed to save PO" });
    });
});

router.get("/purchasing/po-files/:id", (req, res) => {
  getPoFile(req.params.id)
    .then((po) => {
      if (!po) {
        res.status(404).json({ error: "PO not found" });
        return;
      }
      res.json(po);
    })
    .catch((err) => {
      req.log.error({ err }, "PO file fetch failed");
      res.status(500).json({ error: "Failed to fetch PO" });
    });
});

const LOCK_MESSAGES: Record<"printavo" | "vendor", string> = {
  printavo: "PO is locked — it was pushed to Printavo. Unlock it first to make changes.",
  vendor: "PO is locked — it was submitted to the vendor and can no longer be changed.",
};

function sendMutationResult(res: Response, result: PoMutationResult): void {
  if (result.status === "not_found") {
    res.status(404).json({ error: "PO not found" });
    return;
  }
  if (result.status === "locked") {
    res.status(409).json({ error: LOCK_MESSAGES[result.lockReason] });
    return;
  }
  res.json(result.po);
}

/** Mutating a PO mid-push would corrupt the push's view of the lines. */
function rejectIfPushActive(id: string, res: Response): boolean {
  if (isPushActive(id)) {
    res.status(409).json({
      error: "A push to Printavo is in progress — wait for it to finish.",
    });
    return true;
  }
  return false;
}

router.post("/purchasing/po-files/:id/push", (req, res) => {
  startPoPush(req.params.id, req.log)
    .then((result) => {
      switch (result) {
        case "started":
          res.status(202).json({ started: true });
          return;
        case "not_found":
          res.status(404).json({ error: "PO not found" });
          return;
        case "already_running":
          res.status(409).json({ error: "A push for this PO is already running" });
          return;
        case "no_linked_lines":
          res.status(409).json({
            error: "This PO has no Printavo-linked line items to push",
          });
          return;
        case "not_configured":
          res.status(503).json({ error: "Printavo credentials are not configured" });
      }
    })
    .catch((err) => {
      req.log.error({ err }, "PO push start failed");
      res.status(500).json({ error: "Failed to start push" });
    });
});

router.patch("/purchasing/po-files/:id", (req, res) => {
  if (rejectIfPushActive(req.params.id, res)) return;
  const parsed = UpdatePoFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid PO update" });
    return;
  }
  updatePoFile(req.params.id, {
    poNumber: parsed.data.poNumber,
    notes: parsed.data.notes,
    lineItems: parsed.data.lineItems as PoFileLineItem[] | undefined,
  })
    .then((result) => sendMutationResult(res, result))
    .catch((err) => {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "That PO number is already in use" });
        return;
      }
      req.log.error({ err }, "PO file update failed");
      res.status(500).json({ error: "Failed to update PO" });
    });
});

router.post("/purchasing/po-files/:id/line-items", (req, res) => {
  if (rejectIfPushActive(req.params.id, res)) return;
  const parsed = AppendPoLineItemsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid line items payload" });
    return;
  }
  appendPoFileLineItems(req.params.id, parsed.data.lineItems as PoFileLineItem[])
    .then((result) => sendMutationResult(res, result))
    .catch((err) => {
      req.log.error({ err }, "PO line item append failed");
      res.status(500).json({ error: "Failed to add items to PO" });
    });
});

router.post("/purchasing/po-files/:id/submit-to-vendor", (req, res) => {
  const parsed = SubmitPoToVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid submit-to-vendor payload" });
    return;
  }
  const raw = parsed.data.vendorOrderNumber ?? null;
  const vendorOrderNumber = raw && raw.trim().length > 0 ? raw.trim() : null;
  submitPoToVendor(req.params.id, vendorOrderNumber)
    .then((result) => {
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "PO not found" });
          return;
        case "already_submitted":
          res.status(409).json({
            error: "This PO is already marked as submitted to the vendor.",
          });
          return;
        case "ok":
          res.json(result.po);
      }
    })
    .catch((err) => {
      req.log.error({ err }, "PO submit-to-vendor failed");
      res.status(500).json({ error: "Failed to mark PO as submitted" });
    });
});

router.post("/purchasing/po-files/:id/unlock", (req, res) => {
  if (rejectIfPushActive(req.params.id, res)) return;
  unlockPoFile(req.params.id)
    .then((result) => {
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "PO not found" });
          return;
        case "vendor_locked":
          res.status(409).json({
            error:
              "This PO was submitted to the vendor — only an admin can unlock it (Admin unlock, PIN required).",
          });
          return;
        case "not_locked":
          res.status(409).json({ error: "PO is not locked" });
          return;
        case "ok":
          res.json(result.po);
      }
    })
    .catch((err) => {
      req.log.error({ err }, "PO unlock failed");
      res.status(500).json({ error: "Failed to unlock PO" });
    });
});

router.post("/purchasing/po-files/:id/admin-unlock", async (req, res) => {
  if (rejectIfPushActive(req.params.id, res)) return;
  const parsed = AdminUnlockPoFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid admin unlock payload" });
    return;
  }
  const pinOk = await requireValidAdminPin(
    req,
    res,
    parsed.data.adminPin,
    "admin unlock",
    { poFileId: req.params.id },
  );
  if (!pinOk) return;
  adminUnlockVendorPoFile(req.params.id)
    .then((result) => {
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "PO not found" });
          return;
        case "not_vendor_locked":
          res.status(409).json({
            error: "This PO isn't marked as submitted to the vendor.",
          });
          return;
        case "ok":
          req.log.info(
            { poFileId: req.params.id },
            "admin unlock: vendor submission un-marked",
          );
          res.json(result.po);
      }
    })
    .catch((err) => {
      req.log.error({ err }, "PO admin unlock failed");
      res.status(500).json({ error: "Failed to unlock PO" });
    });
});

/**
 * Preview or electronically submit a PO to its vendor.
 *
 * Safety gates (in order):
 * 1. Server kill switch — unless VENDOR_SUBMIT_ENABLED is truthy, ANY test/live
 *    request is coerced to a no-network dry-run preview. This is the outermost
 *    guarantee that no real order goes out until submission is switched on.
 * 2. Admin PIN — required for a real send (test/live), with the same 5-strike /
 *    15-minute lockout as the admin unlock. dry-run needs no PIN.
 * The orchestrator (submitVendorOrder) enforces eligibility + single-active-
 * order idempotency and records the attempt.
 */
router.post("/purchasing/po-files/:id/vendor-submit", async (req, res) => {
  const parsed = VendorSubmitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid vendor-submit payload" });
    return;
  }
  const requestedMode = (parsed.data.mode ?? "dry_run") as "dry_run" | "test" | "live";
  const submitEnabled =
    process.env.VENDOR_SUBMIT_ENABLED === "true" ||
    process.env.VENDOR_SUBMIT_ENABLED === "1";
  const effectiveMode = submitEnabled ? requestedMode : "dry_run";

  if (effectiveMode !== "dry_run") {
    const pinOk = await requireValidAdminPin(
      req,
      res,
      parsed.data.adminPin ?? undefined,
      "vendor-submit",
      { poFileId: req.params.id },
    );
    if (!pinOk) return;
  }

  submitVendorOrder(req.params.id, effectiveMode)
    .then((result) => {
      if (result.outcome === "not_found") {
        res.status(404).json({ error: "PO not found" });
        return;
      }
      // A test/live request that got coerced to preview — tell the user why.
      if (!submitEnabled && requestedMode !== "dry_run") {
        result.message =
          "Electronic submission is turned off on the server — this is a preview only.";
      }
      req.log.info(
        {
          poFileId: req.params.id,
          requestedMode,
          effectiveMode,
          outcome: result.outcome,
          vendor: result.vendor,
        },
        "vendor-submit",
      );
      res.json(result);
    })
    .catch((err) => {
      req.log.error({ err }, "vendor-submit failed");
      res.status(500).json({ error: "Failed to submit vendor order" });
    });
});

router.get("/purchasing/vendor-orders", (req, res) => {
  const poFileId =
    typeof req.query.poFileId === "string" && req.query.poFileId ? req.query.poFileId : undefined;
  listVendorOrders(poFileId)
    .then((orders) => res.json({ orders }))
    .catch((err) => {
      req.log.error({ err }, "list vendor orders failed");
      res.status(500).json({ error: "Failed to load vendor orders" });
    });
});

router.get("/purchasing/external-vendor-orders", async (req, res) => {
  try { res.json(await listExternalVendorOrders()); }
  catch (err) { req.log.error({err}, "external tracking list failed"); res.status(500).json({error:"Could not load external orders"}); }
});
router.post("/purchasing/external-vendor-orders/import", async (req, res) => {
  try { res.json(await importExternalVendorOrders()); }
  catch (err) { req.log.error({err}, "external history import failed"); res.status(409).json({error:"External import is already running or unavailable"}); }
});
router.post("/purchasing/external-vendor-orders/:id/refresh", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) { res.status(400).json({error:"Invalid tracking ID"}); return; }
  try {
    const row = await refreshExternalVendorOrder(req.params.id);
    if (!row) { res.status(404).json({error:"External order not found"}); return; }
    res.json(row);
  } catch (err) { req.log.error({err}, "external tracking refresh failed"); res.status(502).json({error:"Vendor lookup failed. Previous tracking has been retained."}); }
});

router.get("/purchasing/carrier-tracking/settings", async (req, res) => {
  try { res.json(await getCarrierTrackingSettings()); }
  catch (err) { req.log.error({ err }, "carrier settings read failed"); res.status(500).json({ error: "Could not load carrier settings" }); }
});

router.put("/purchasing/carrier-tracking/settings", async (req, res) => {
  const parsed = SetCarrierTrackingSettingsBody.safeParse(req.body);
  if (!parsed.success || (parsed.data.enabled && !parsed.data.confirmFees)) {
    res.status(400).json({ error: "Admin PIN and explicit fee confirmation required to enable paid Shippo tracking" });
    return;
  }
  if (!await requireValidAdminPin(req, res, parsed.data.adminPin, "shippo tracking opt-in")) return;
  try { res.json(await setCarrierTrackingSettings(parsed.data.enabled)); }
  catch (err) { req.log.error({ err }, "carrier settings save failed"); res.status(500).json({ error: "Could not save carrier settings" }); }
});

router.post("/purchasing/vendor-orders/:id/refresh-carrier", async (req, res) => {
  try {
    const result = await refreshCarrierTracking(req.params.id);
    res.status(result.outcome === "not_found" ? 404 : 200).json(result);
  } catch (err) {
    req.log.error({ err, vendorOrderId: req.params.id }, "carrier refresh failed");
    res.status(500).json({ error: "Could not refresh carrier tracking" });
  }
});

/**
 * Read-only vendor status/tracking refresh. Reconcile is asymmetric BY DESIGN:
 * unknown→submitted is automatic when the vendor confirms (guard stays locked),
 * unknown→failed only ever happens via the PIN-gated mark-failed route below.
 */
router.post("/purchasing/vendor-orders/refresh-active", (req, res) => {
  refreshActiveVendorOrders()
    .then((result) => {
      req.log.info(
        {
          checked: result.checked,
          refreshed: result.refreshed,
          reconciled: result.reconciled,
          noRecord: result.noRecord,
          errors: result.errors,
        },
        "vendor-orders refresh-active",
      );
      res.json(result);
    })
    .catch((err) => {
      req.log.error({ err }, "refresh-active failed");
      res.status(500).json({ error: "Failed to refresh vendor orders" });
    });
});

router.post("/purchasing/vendor-orders/:id/refresh", (req, res) => {
  refreshVendorOrderStatus(req.params.id)
    .then((result) => {
      if (result.outcome === "not_found") {
        res.status(404).json({ error: "Vendor order not found" });
        return;
      }
      req.log.info(
        { vendorOrderId: req.params.id, outcome: result.outcome },
        "vendor-order refresh",
      );
      res.json(result);
    })
    .catch((err) => {
      req.log.error({ err, vendorOrderId: req.params.id }, "vendor-order refresh failed");
      res.status(500).json({ error: "Failed to refresh vendor order" });
    });
});

/**
 * Manually resolve an UNKNOWN order as failed — releases the anti-double-order
 * lock, so it's PIN-gated with the same lockout as the other admin actions.
 */
router.post("/purchasing/vendor-orders/:id/mark-failed", async (req, res) => {
  const parsed = MarkVendorOrderFailedBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mark-failed payload" });
    return;
  }
  const pinOk = await requireValidAdminPin(
    req,
    res,
    parsed.data.adminPin,
    "vendor-order mark-failed",
    { vendorOrderId: req.params.id },
  );
  if (!pinOk) return;
  markVendorOrderFailed(req.params.id, parsed.data.note ?? null)
    .then((result) => {
      if (result.outcome === "not_found") {
        res.status(404).json({ error: "Vendor order not found" });
        return;
      }
      if (result.outcome === "not_refreshable") {
        res.status(409).json({ error: result.message ?? "Order is not in unknown status" });
        return;
      }
      req.log.info(
        { vendorOrderId: req.params.id },
        "vendor-order manually marked failed (lock released)",
      );
      res.json(result);
    })
    .catch((err) => {
      req.log.error({ err, vendorOrderId: req.params.id }, "mark-failed failed");
      res.status(500).json({ error: "Failed to mark vendor order failed" });
    });
});

router.get("/purchasing/settings/ship-to", (_req, res) => {
  getVendorShipTo()
    .then((shipTo) => res.json({ shipTo }))
    .catch((err) => {
      _req.log.error({ err }, "get ship-to failed");
      res.status(500).json({ error: "Failed to load ship-to address" });
    });
});

router.put("/purchasing/settings/ship-to", (req, res) => {
  const parsed = SetVendorShipToBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ship-to payload" });
    return;
  }
  setVendorShipTo(parsed.data as VendorShipTo)
    .then((shipTo) => res.json(shipTo))
    .catch((err) => {
      req.log.error({ err }, "save ship-to failed");
      res.status(500).json({ error: "Failed to save ship-to address" });
    });
});

router.delete("/purchasing/po-files/:id", (req, res) => {
  if (rejectIfPushActive(req.params.id, res)) return;
  deletePoFile(req.params.id)
    .then((outcome) => {
      if (outcome === "not_found") {
        res.status(404).json({ error: "PO not found" });
        return;
      }
      if (outcome === "locked") {
        res.status(409).json({ error: "PO is locked and cannot be deleted" });
        return;
      }
      res.status(204).end();
    })
    .catch((err) => {
      req.log.error({ err }, "PO file delete failed");
      res.status(500).json({ error: "Failed to delete PO" });
    });
});

/* PO HTML by secret token moved to purchasingPublic.ts — it must stay
 * unauthenticated (Printavo fetches it server-to-server) and is mounted
 * BEFORE requireStaff in routes/index.ts. */

/* ── Status rules engine (P3d) ───────────────────────────────────────── */

router.get("/purchasing/printavo-statuses", (req, res) => {
  listPrintavoStatuses()
    .then((statuses) => res.json({ statuses }))
    .catch((err) => {
      req.log.error({ err }, "Printavo status list failed");
      res.status(500).json({ error: "Failed to list statuses" });
    });
});

router.get("/purchasing/status-rules", (req, res) => {
  listStatusRules()
    .then((rules) => res.json({ rules }))
    .catch((err) => {
      req.log.error({ err }, "Status rule list failed");
      res.status(500).json({ error: "Failed to list status rules" });
    });
});

router.post("/purchasing/status-rules", (req, res) => {
  const parsed = CreateStatusRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid status rule" });
    return;
  }
  createStatusRule(parsed.data as StatusRuleInput)
    .then((result) => {
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      if (result.status === "ok") {
        res.status(201).json(result.rule);
      }
    })
    .catch((err) => {
      req.log.error({ err }, "Status rule create failed");
      res.status(500).json({ error: "Failed to create status rule" });
    });
});

router.patch("/purchasing/status-rules/:id", (req, res) => {
  const parsed = UpdateStatusRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid status rule update" });
    return;
  }
  updateStatusRule(req.params.id, parsed.data as StatusRuleInput)
    .then((result) => {
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "Rule not found" });
          return;
        case "invalid":
          res.status(400).json({ error: result.message });
          return;
        case "ok":
          res.json(result.rule);
      }
    })
    .catch((err) => {
      req.log.error({ err }, "Status rule update failed");
      res.status(500).json({ error: "Failed to update status rule" });
    });
});

router.post("/purchasing/status-rules/reorder", (req, res) => {
  const parsed = ReorderStatusRulesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid reorder request" });
    return;
  }
  reorderStatusRules(parsed.data.orderedIds)
    .then((result) => {
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      res.json({ rules: result.rules });
    })
    .catch((err) => {
      req.log.error({ err }, "Status rule reorder failed");
      res.status(500).json({ error: "Failed to reorder status rules" });
    });
});

router.delete("/purchasing/status-rules/:id", (req, res) => {
  deleteStatusRule(req.params.id)
    .then((outcome) => {
      if (outcome === "not_found") {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      res.status(204).end();
    })
    .catch((err) => {
      req.log.error({ err }, "Status rule delete failed");
      res.status(500).json({ error: "Failed to delete status rule" });
    });
});

router.get("/purchasing/status-suggestions", (req, res) => {
  const scope = req.query.scope === "all" ? "all" : "open";
  listStatusSuggestions(scope)
    .then((suggestions) => res.json({ suggestions }))
    .catch((err) => {
      req.log.error({ err }, "Status suggestion list failed");
      res.status(500).json({ error: "Failed to list status suggestions" });
    });
});

router.post("/purchasing/status-suggestions/evaluate", (req, res) => {
  evaluateRecentPushedOrders(req.log)
    .then((summary) => res.json(summary))
    .catch((err) => {
      req.log.error({ err }, "Status rule evaluation failed");
      res.status(500).json({ error: "Failed to evaluate status rules" });
    });
});

router.post("/purchasing/status-suggestions/:id/apply", (req, res) => {
  applyStatusSuggestion(req.params.id, req.log)
    .then((result) => {
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "Suggestion not found" });
          return;
        case "invalid_state":
          res.status(409).json({
            error: `This suggestion was already ${result.state}`,
          });
          return;
        case "already_in_target":
          res.status(409).json({
            error:
              "The order is already in the suggested status — suggestion cleared",
          });
          return;
        case "stale_status":
          res.status(409).json({
            error: `The order's status changed to "${result.suggestion.currentStatusName ?? "unknown"}" since this was suggested — review and apply again`,
          });
          return;
        case "not_configured":
          res.status(503).json({ error: "Printavo credentials are not configured" });
          return;
        case "gateway_error":
          res.status(502).json({
            error: `Printavo rejected the status change: ${result.error}`,
            suggestion: result.suggestion,
          });
          return;
        case "ok":
          res.json(result.suggestion);
      }
    })
    .catch((err) => {
      req.log.error({ err }, "Status suggestion apply failed");
      res.status(500).json({ error: "Failed to apply status change" });
    });
});

router.post("/purchasing/status-suggestions/:id/dismiss", (req, res) => {
  dismissStatusSuggestion(req.params.id)
    .then((result) => {
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "Suggestion not found" });
          return;
        case "invalid_state":
          res.status(409).json({
            error: `This suggestion was already ${result.state}`,
          });
          return;
        case "ok":
          res.json(result.suggestion);
      }
    })
    .catch((err) => {
      req.log.error({ err }, "Status suggestion dismiss failed");
      res.status(500).json({ error: "Failed to dismiss suggestion" });
    });
});

router.get("/purchasing/po-files/:id/html", (req, res) => {
  getPoFile(req.params.id)
    .then((po) => {
      if (!po) {
        res.status(404).send("PO not found");
        return;
      }
      res.type("html").send(renderPoHtml(po));
    })
    .catch((err) => {
      req.log.error({ err }, "PO render failed");
      res.status(500).send("Failed to render PO");
    });
});

export default router;
