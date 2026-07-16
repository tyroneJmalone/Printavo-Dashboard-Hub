import { randomBytes } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreatePqStatusRuleBody,
  UpdatePqStatusRuleBody,
  ReorderPqStatusRulesBody,
  SetPqAutomationBody,
  EvaluatePqRulesAndRunBody,
  StartPqStatusJobBody,
  UpdateAutoPrintConfigBody,
  StartAutoPrintRunBody,
} from "@workspace/api-zod";
import { listPrintQueueOrders } from "../lib/printQueue/orders";
import {
  buildCombinedWorkordersHtml,
  MAX_ORDERS,
} from "../lib/printQueue/workorderHtml";
import {
  loadShippingDocOrders,
  MAX_SHIPPING_DOC_ORDERS,
} from "../lib/printQueue/shippingDocs";
import { renderCombinedPackingSlipsHtml } from "../lib/printQueue/packingSlipHtml";
import {
  renderCombinedBoxLabelsHtml,
  MAX_LABELS_PER_ORDER,
} from "../lib/printQueue/boxLabelHtml";
import {
  getPqAutomationEnabled,
  setPqAutomationEnabled,
  listPqStatusRules,
  createPqStatusRule,
  updatePqStatusRule,
  deletePqStatusRule,
  reorderPqStatusRules,
  evaluatePqRules,
  MAX_EVALUATE_ORDERS,
  type PqRuleInput,
} from "../lib/printQueue/statusRules";
import {
  startPqStatusJob,
  getPqStatusJob,
  listPqStatusJobs,
  type PqJobLineInput,
} from "../lib/printQueue/statusJobs";
import {
  getAutoPrintConfig,
  setAutoPrintConfig,
} from "../lib/printQueue/autoPrint/config";
import {
  printNodeConfigured,
  listPrinters,
} from "../lib/printQueue/autoPrint/printNode";
import {
  startAutoPrintRun,
  getPrintRun,
  listPrintRuns,
  listPrintJobs,
} from "../lib/printQueue/autoPrint/engine";
import { db, pvImprintsTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";

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

/* ── Shipping documents rendered from the local sync (PQ3b) ──────────── */

/** Shared ids parsing: dedup, cap, 400 on empty/oversized. Returns null after responding. */
function parseDocIds(req: Request, res: Response): string[] | null {
  const raw = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) {
    res.status(400).json({ error: "ids is required" });
    return null;
  }
  if (ids.length > MAX_SHIPPING_DOC_ORDERS) {
    res
      .status(400)
      .json({ error: `Maximum ${MAX_SHIPPING_DOC_ORDERS} orders per batch` });
    return null;
  }
  return ids;
}

function sendShippingDoc(res: Response, nonce: string, html: string): void {
  res.setHeader(
    "Content-Security-Policy",
    `script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`,
  );
  res.type("html").send(html);
}

router.get("/print-queue/packing-slips/html", (req, res) => {
  const ids = parseDocIds(req, res);
  if (!ids) return;
  const nonce = randomBytes(16).toString("base64");
  loadShippingDocOrders(ids)
    .then((orders) => {
      if (orders.length === 0) {
        res.status(404).json({ error: "No matching invoices" });
        return;
      }
      sendShippingDoc(res, nonce, renderCombinedPackingSlipsHtml(orders, nonce));
    })
    .catch((err) => {
      req.log.error({ err }, "packing slips HTML failed");
      res.status(500).json({ error: "Failed to build packing slips" });
    });
});

router.get("/print-queue/box-labels/html", (req, res) => {
  const ids = parseDocIds(req, res);
  if (!ids) return;
  let perOrder: number | null = null;
  if (typeof req.query.perOrder === "string" && req.query.perOrder !== "") {
    const n = Number(req.query.perOrder);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LABELS_PER_ORDER) {
      res
        .status(400)
        .json({ error: `perOrder must be 1-${MAX_LABELS_PER_ORDER}` });
      return;
    }
    perOrder = n;
  }
  const nonce = randomBytes(16).toString("base64");
  loadShippingDocOrders(ids)
    .then((orders) => {
      if (orders.length === 0) {
        res.status(404).json({ error: "No matching invoices" });
        return;
      }
      sendShippingDoc(
        res,
        nonce,
        renderCombinedBoxLabelsHtml(orders, nonce, perOrder),
      );
    })
    .catch((err) => {
      req.log.error({ err }, "box labels HTML failed");
      res.status(500).json({ error: "Failed to build box labels" });
    });
});

/* ── Print Queue rules + bulk status jobs (PQ2) ──────────────────────── */

router.get("/print-queue/rules", (req, res) => {
  listPqStatusRules()
    .then((rules) => res.json({ rules }))
    .catch((err) => {
      req.log.error({ err }, "pq rules list failed");
      res.status(500).json({ error: "Failed to list rules" });
    });
});

router.post("/print-queue/rules", (req, res) => {
  const parsed = CreatePqStatusRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid rule" });
    return;
  }
  createPqStatusRule(parsed.data as PqRuleInput)
    .then((result) => {
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      if (result.status !== "ok") {
        res.status(400).json({ error: "Invalid rule" });
        return;
      }
      res.status(201).json(result.rule);
    })
    .catch((err) => {
      req.log.error({ err }, "pq rule create failed");
      res.status(500).json({ error: "Failed to create rule" });
    });
});

router.patch("/print-queue/rules/:id", (req, res) => {
  const parsed = UpdatePqStatusRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid rule" });
    return;
  }
  updatePqStatusRule(req.params.id, parsed.data as PqRuleInput)
    .then((result) => {
      if (result.status === "not_found") {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      res.json(result.rule);
    })
    .catch((err) => {
      req.log.error({ err }, "pq rule update failed");
      res.status(500).json({ error: "Failed to update rule" });
    });
});

router.delete("/print-queue/rules/:id", (req, res) => {
  deletePqStatusRule(req.params.id)
    .then((result) => {
      if (result === "not_found") {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      res.status(204).end();
    })
    .catch((err) => {
      req.log.error({ err }, "pq rule delete failed");
      res.status(500).json({ error: "Failed to delete rule" });
    });
});

router.post("/print-queue/rules/reorder", (req, res) => {
  const parsed = ReorderPqStatusRulesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "orderedIds is required" });
    return;
  }
  reorderPqStatusRules(parsed.data.orderedIds)
    .then((result) => {
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      res.json({ rules: result.rules });
    })
    .catch((err) => {
      req.log.error({ err }, "pq rules reorder failed");
      res.status(500).json({ error: "Failed to reorder rules" });
    });
});

router.get("/print-queue/automation", (req, res) => {
  getPqAutomationEnabled()
    .then((enabled) => res.json({ enabled }))
    .catch((err) => {
      req.log.error({ err }, "pq automation read failed");
      res.status(500).json({ error: "Failed to read automation setting" });
    });
});

router.put("/print-queue/automation", (req, res) => {
  const parsed = SetPqAutomationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "enabled (boolean) is required" });
    return;
  }
  setPqAutomationEnabled(parsed.data.enabled)
    .then((enabled) => res.json({ enabled }))
    .catch((err) => {
      req.log.error({ err }, "pq automation write failed");
      res.status(500).json({ error: "Failed to save automation setting" });
    });
});

router.post("/print-queue/rules/evaluate-and-run", (req, res) => {
  const parsed = EvaluatePqRulesAndRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "orderIds is required" });
    return;
  }
  const orderIds = [...new Set(parsed.data.orderIds)];
  if (orderIds.length > MAX_EVALUATE_ORDERS) {
    res
      .status(400)
      .json({ error: `Maximum ${MAX_EVALUATE_ORDERS} orders per evaluation` });
    return;
  }
  (async () => {
    // Kill switch is enforced HERE, server-side — when off, nothing is
    // evaluated and nothing runs, regardless of what the client sends.
    const automationEnabled = await getPqAutomationEnabled();
    if (!automationEnabled) {
      return {
        automationEnabled: false,
        autoJobId: null as string | null,
        autoCount: 0,
        askItems: [],
        noChangeCount: 0,
        alreadyInTargetCount: 0,
        unmatchedCount: 0,
      };
    }
    const evaluation = await evaluatePqRules(orderIds, req.log);
    let autoJobId: string | null = null;
    let askItems = evaluation.askItems;
    if (evaluation.autoItems.length > 0) {
      // Auto matches start in the SAME call — a closed tab can't strand them.
      const started = await startPqStatusJob(
        "auto",
        evaluation.autoItems.map((item) => ({
          orderId: item.orderId,
          targetStatusId: item.targetStatusId,
          expectedStatusId: item.fromStatusId,
        })),
        req.log,
      );
      if (started.status === "started") {
        autoJobId = started.job.id;
      } else {
        // Couldn't start (another job running / not configured) — degrade
        // to ask-first so nothing is silently dropped.
        req.log.warn(
          { reason: started.status },
          "pq auto job could not start; degrading auto matches to ask",
        );
        askItems = [...evaluation.autoItems, ...askItems];
      }
    }
    return {
      automationEnabled: true,
      autoJobId,
      autoCount: autoJobId ? evaluation.autoItems.length : 0,
      askItems,
      noChangeCount: evaluation.noChangeCount,
      alreadyInTargetCount: evaluation.alreadyInTargetCount,
      unmatchedCount: evaluation.unmatchedCount,
    };
  })()
    .then((result) => res.json(result))
    .catch((err) => {
      req.log.error({ err }, "pq evaluate-and-run failed");
      res.status(500).json({ error: "Failed to evaluate rules" });
    });
});

router.get("/print-queue/status-jobs", (req, res) => {
  const limit = Number(req.query.limit) || 5;
  listPqStatusJobs(limit)
    .then((jobs) => res.json({ jobs }))
    .catch((err) => {
      req.log.error({ err }, "pq status jobs list failed");
      res.status(500).json({ error: "Failed to list jobs" });
    });
});

router.post("/print-queue/status-jobs", (req, res) => {
  const parsed = StartPqStatusJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid job" });
    return;
  }
  startPqStatusJob(
    parsed.data.trigger,
    parsed.data.lines as PqJobLineInput[],
    req.log,
  )
    .then((result) => {
      if (result.status === "conflict") {
        res.status(409).json({ error: "A status change job is already running" });
        return;
      }
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      if (result.status === "not_configured") {
        res.status(503).json({ error: "Printavo credentials not configured" });
        return;
      }
      res.status(202).json(result.job);
    })
    .catch((err) => {
      req.log.error({ err }, "pq status job start failed");
      res.status(500).json({ error: "Failed to start job" });
    });
});

router.get("/print-queue/status-jobs/:id", (req, res) => {
  getPqStatusJob(req.params.id)
    .then((job) => {
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json(job);
    })
    .catch((err) => {
      req.log.error({ err }, "pq status job read failed");
      res.status(500).json({ error: "Failed to read job" });
    });
});

/* ── Auto-print (PQ3a) ───────────────────────────────────────────────── */

router.get("/print-queue/autoprint/config", (req, res) => {
  getAutoPrintConfig()
    .then((config) => res.json(config))
    .catch((err) => {
      req.log.error({ err }, "autoprint config read failed");
      res.status(500).json({ error: "Failed to read config" });
    });
});

router.put("/print-queue/autoprint/config", (req, res) => {
  const parsed = UpdateAutoPrintConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid config" });
    return;
  }
  setAutoPrintConfig(parsed.data)
    .then((config) => res.json(config))
    .catch((err) => {
      req.log.error({ err }, "autoprint config save failed");
      res.status(500).json({ error: "Failed to save config" });
    });
});

router.get("/print-queue/autoprint/printers", (req, res) => {
  if (!printNodeConfigured()) {
    res.json({ configured: false, printers: [] });
    return;
  }
  listPrinters()
    .then((printers) => res.json({ configured: true, printers }))
    .catch((err) => {
      req.log.error({ err }, "printnode printer list failed");
      res.status(502).json({ error: "PrintNode request failed" });
    });
});

router.get("/print-queue/autoprint/categories", (req, res) => {
  db
    .selectDistinct({ typeOfWork: pvImprintsTable.typeOfWork })
    .from(pvImprintsTable)
    .where(isNotNull(pvImprintsTable.typeOfWork))
    .then((rows) => {
      const categories = [
        ...new Set(
          rows
            .map((r) => (r.typeOfWork ?? "").trim())
            .filter((c) => c.length > 0),
        ),
      ].sort((a, b) => a.localeCompare(b));
      res.json({ categories });
    })
    .catch((err) => {
      req.log.error({ err }, "imprint category list failed");
      res.status(500).json({ error: "Failed to list categories" });
    });
});

router.post("/print-queue/autoprint/run", (req, res) => {
  const parsed = StartAutoPrintRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }
  startAutoPrintRun(
    "manual",
    { dryRun: parsed.data.dryRun ?? undefined },
    req.log,
  )
    .then((result) => {
      if (result.status === "conflict") {
        res.status(409).json({ error: "An auto-print run is already in progress" });
        return;
      }
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      res.status(202).json(result.run);
    })
    .catch((err) => {
      req.log.error({ err }, "autoprint run start failed");
      res.status(500).json({ error: "Failed to start run" });
    });
});

router.get("/print-queue/autoprint/runs", (req, res) => {
  const limit = Number(req.query.limit) || 10;
  listPrintRuns(limit)
    .then((runs) => res.json({ runs }))
    .catch((err) => {
      req.log.error({ err }, "autoprint run list failed");
      res.status(500).json({ error: "Failed to list runs" });
    });
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/print-queue/autoprint/runs/:id", (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  getPrintRun(req.params.id)
    .then((run) => {
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(run);
    })
    .catch((err) => {
      req.log.error({ err }, "autoprint run read failed");
      res.status(500).json({ error: "Failed to read run" });
    });
});

router.get("/print-queue/autoprint/jobs", (req, res) => {
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  const limit = Number(req.query.limit) || 50;
  listPrintJobs({ runId, limit })
    .then((jobs) => res.json({ jobs }))
    .catch((err) => {
      req.log.error({ err }, "autoprint job list failed");
      res.status(500).json({ error: "Failed to list jobs" });
    });
});

export default router;
