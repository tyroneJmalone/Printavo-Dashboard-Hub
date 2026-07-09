import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  VendorLookupBody,
  VendorInventoryBody,
  CreatePoFileBody,
  UpdatePoFileBody,
  AppendPoLineItemsBody,
  SubmitPoToVendorBody,
  AdminUnlockPoFileBody,
  CreateStatusRuleBody,
  UpdateStatusRuleBody,
  ReorderStatusRulesBody,
} from "@workspace/api-zod";
import { loadNeedsOrdering } from "../lib/purchasing/needsOrdering";
import { vendorLookup, VendorConfigError } from "../lib/purchasing/vendorLookup";
import { vendorInventory } from "../lib/purchasing/vendorInventory";
import {
  createPoFile,
  listPoFiles,
  getPoFile,
  getPoFileByHtmlToken,
  updatePoFile,
  appendPoFileLineItems,
  unlockPoFile,
  adminUnlockVendorPoFile,
  deletePoFile,
  submitPoToVendor,
  type PoFileLineItem,
  type PoMutationResult,
} from "../lib/purchasing/poFiles";
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

/**
 * Purchasing (Vendor Orders) module routes.
 * Phase 1: needs-ordering scan (Postgres only).
 * Phase 2: live vendor lookups (SanMar/S&S) + PO files.
 */

const router: IRouter = Router();

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

/** Constant-time PIN check against the ADMIN_PIN secret. */
function adminPinMatches(pin: string): boolean {
  const expected = process.env.ADMIN_PIN;
  if (!expected) return false;
  const a = createHash("sha256").update(pin).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Brute-force friction for the admin PIN: after 5 wrong attempts, further
 * tries are rejected for 15 minutes (process-wide — this is an internal
 * single-user app). Reset on success or restart.
 */
const PIN_MAX_FAILURES = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
let pinFailures = 0;
let pinLockedUntil = 0;

router.post("/purchasing/po-files/:id/admin-unlock", (req, res) => {
  if (rejectIfPushActive(req.params.id, res)) return;
  const parsed = AdminUnlockPoFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid admin unlock payload" });
    return;
  }
  if (!process.env.ADMIN_PIN) {
    res.status(403).json({
      error: "Admin PIN isn't set up yet — add the ADMIN_PIN secret first.",
    });
    return;
  }
  if (Date.now() < pinLockedUntil) {
    const mins = Math.ceil((pinLockedUntil - Date.now()) / 60_000);
    res.status(429).json({
      error: `Too many wrong PIN attempts — try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
    });
    return;
  }
  if (!adminPinMatches(parsed.data.adminPin)) {
    pinFailures += 1;
    if (pinFailures >= PIN_MAX_FAILURES) {
      pinLockedUntil = Date.now() + PIN_LOCKOUT_MS;
      pinFailures = 0;
      req.log.warn(
        { poFileId: req.params.id },
        "admin unlock: too many wrong PINs — locked out 15 min",
      );
    } else {
      req.log.warn({ poFileId: req.params.id }, "admin unlock rejected: wrong PIN");
    }
    res.status(403).json({ error: "Incorrect admin PIN" });
    return;
  }
  pinFailures = 0;
  pinLockedUntil = 0;
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

/**
 * PUBLIC (unauthenticated) PO HTML by secret token — the URL handed to
 * Printavo's productionFileCreate. The token is a 64-char hex secret,
 * regenerated on every push; this must stay the ONLY public endpoint.
 * The optional trailing :filename segment is ignored — it only makes
 * Printavo name the attached file after the PO number.
 */
const servePublicPoHtml = (
  req: Request<{ token: string; filename?: string }>,
  res: Response,
) => {
  getPoFileByHtmlToken(req.params.token)
    .then((po) => {
      if (!po) {
        res.status(404).send("Not found");
        return;
      }
      res.type("html").send(renderPoHtml(po));
    })
    .catch((err) => {
      req.log.error({ err }, "public PO render failed");
      res.status(500).send("Render failed");
    });
};
router.get("/purchasing/po-html/:token", servePublicPoHtml);
router.get("/purchasing/po-html/:token/:filename", servePublicPoHtml);

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
