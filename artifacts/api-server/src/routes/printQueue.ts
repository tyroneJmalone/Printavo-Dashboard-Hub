import { randomBytes } from "node:crypto";
import { Router, type IRouter } from "express";
import { listPrintQueueOrders } from "../lib/printQueue/orders";
import {
  buildCombinedWorkordersHtml,
  MAX_ORDERS,
} from "../lib/printQueue/workorderHtml";

const router: IRouter = Router();

/* ── Print Queue — manual mode, read-only (PQ1) ──────────────────────── */

router.get("/print-queue/orders", (req, res) => {
  const raw = typeof req.query.statusIds === "string" ? req.query.statusIds : "";
  const statusIds = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (statusIds.length === 0) {
    res.status(400).json({ error: "statusIds is required" });
    return;
  }
  listPrintQueueOrders(statusIds)
    .then((orders) => res.json({ orders }))
    .catch((err) => {
      req.log.error({ err }, "print queue order list failed");
      res.status(500).json({ error: "Failed to list orders" });
    });
});

router.get("/print-queue/workorders/html", (req, res) => {
  const raw = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) {
    res.status(400).json({ error: "ids is required" });
    return;
  }
  if (ids.length > MAX_ORDERS) {
    res.status(400).json({ error: `Maximum ${MAX_ORDERS} orders per batch` });
    return;
  }
  const excludeAttachments =
    req.query.excludeAttachments === "true" || req.query.excludeAttachments === "1";
  // Nonce-based CSP: only OUR page-controls script runs; scripts embedded in
  // the fetched Printavo pages (analytics beacons etc.) stay blocked.
  const nonce = randomBytes(16).toString("base64");
  buildCombinedWorkordersHtml(ids, req.log, { nonce, excludeAttachments })
    .then((html) => {
      if (html == null) {
        res.status(404).json({ error: "No matching orders" });
        return;
      }
      res.setHeader(
        "Content-Security-Policy",
        `script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`,
      );
      res.type("html").send(html);
    })
    .catch((err) => {
      req.log.error({ err }, "combined workorder HTML failed");
      res.status(500).json({ error: "Failed to build workorder document" });
    });
});

export default router;
