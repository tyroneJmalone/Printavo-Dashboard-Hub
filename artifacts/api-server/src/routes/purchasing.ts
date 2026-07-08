import { Router, type IRouter, type Response } from "express";
import {
  VendorLookupBody,
  CreatePoFileBody,
  UpdatePoFileBody,
  AppendPoLineItemsBody,
} from "@workspace/api-zod";
import { loadNeedsOrdering } from "../lib/purchasing/needsOrdering";
import { vendorLookup, VendorConfigError } from "../lib/purchasing/vendorLookup";
import {
  createPoFile,
  listPoFiles,
  getPoFile,
  getPoFileByHtmlToken,
  updatePoFile,
  appendPoFileLineItems,
  unlockPoFile,
  deletePoFile,
  type PoFileLineItem,
  type PoMutationResult,
} from "../lib/purchasing/poFiles";
import { renderPoHtml } from "../lib/purchasing/poHtml";

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
  const { vendor, style } = parsed.data;
  vendorLookup(vendor, style)
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

router.patch("/purchasing/po-files/:id", (req, res) => {
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

router.post("/purchasing/po-files/:id/unlock", (req, res) => {
  unlockPoFile(req.params.id)
    .then((result) => {
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "PO not found" });
          return;
        case "vendor_locked":
          res.status(409).json({
            error: "This PO was submitted to the vendor — it can never be unlocked.",
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

router.delete("/purchasing/po-files/:id", (req, res) => {
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
 */
router.get("/purchasing/po-html/:token", (req, res) => {
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
