/**
 * Hub Price Calculator routes.
 *
 * Staff-gated routes (require session):
 *   GET  /hub/invoices/search         — exact/prefix invoice search
 *   POST /hub/pricing/interpret       — AI extraction → calculator fill
 *   POST /hub/uploads/request-png-url — reserve upload slot + presigned PUT
 *   POST /hub/calculator/push         — push to Printavo (note + file)
 *
 * Public unauthenticated route (no session needed — Printavo fetches it):
 *   GET  /hub/uploads/:token/:filename — serve PNG by high-entropy token
 *   (This route is mounted separately in routes/hubPublic.ts)
 */

import { Router, type IRouter } from "express";
import {
  InterpretHubPricingPromptBody,
  RequestHubPngUploadUrlBody,
  PushHubCalculatorBody,
  SearchHubInvoicesQueryParams,
  PreviewHubCalculatorHandoffBody,
  CommitHubCalculatorHandoffBody,
} from "@workspace/api-zod";
import {
  commitHandoff,
  HandoffConflictError,
  HandoffValidationError,
  previewHandoff,
} from "../lib/hub/calcHandoff";
import { searchHubInvoices } from "../lib/hub/invoiceSearch";
import {
  interpretPricingPrompt,
  PricingInterpretError,
} from "../lib/hub/pricingInterpreter";
import {
  reservePngUploadSlot,
  HubUploadError,
} from "../lib/hub/pngStorage";
import { pushCalcToInvoice, CalcPushError } from "../lib/hub/calcPush";
import { listHubCalculatorCategories } from "../lib/hub/calcLineItems";

const router: IRouter = Router();

router.get("/hub/calculator/categories", async (req, res) => {
  try {
    res.json({ categories: await listHubCalculatorCategories() });
  } catch (err) {
    req.log.error({ err }, "Hub calculator category listing failed");
    res.status(500).json({ error: "Failed to list Printavo categories" });
  }
});

// ── Invoice search ─────────────────────────────────────────────────────

router.get("/hub/invoices/search", async (req, res) => {
  const parsed = SearchHubInvoicesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "q must be 1–20 digit characters" });
    return;
  }
  try {
    const invoices = await searchHubInvoices(
      parsed.data.q,
      parsed.data.limit ?? 10,
    );
    res.json({ invoices });
  } catch (err) {
    req.log.error({ err }, "Hub invoice search failed");
    res.status(500).json({ error: "Invoice search failed" });
  }
});

// ── AI pricing interpretation ─────────────────────────────────────────

router.post("/hub/pricing/interpret", async (req, res) => {
  const parsed = InterpretHubPricingPromptBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Prompt must be 8–10,000 characters" });
    return;
  }
  try {
    const result = await interpretPricingPrompt(parsed.data.prompt.trim());
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Hub pricing interpretation failed");
    if (err instanceof PricingInterpretError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(503).json({
      error: "Pricing interpretation is temporarily unavailable",
    });
  }
});

// ── PNG upload slot ────────────────────────────────────────────────────

router.post("/hub/uploads/request-png-url", async (req, res) => {
  const parsed = RequestHubPngUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  try {
    const slot = await reservePngUploadSlot({
      invoiceId: parsed.data.invoiceId,
      visualId: parsed.data.visualId,
      rangeKey: parsed.data.rangeKey,
      priceRows: parsed.data.priceRows,
      // The destination order's visible number is the only note/export identity.
      quoteNumber: String(parsed.data.visualId),
      note: parsed.data.note ?? null,
      lineItem: parsed.data.lineItem ?? null,
      noteSections: parsed.data.noteSections ?? null,
    });
    res.json({
      uploadId: slot.uploadId,
      uploadUrl: slot.uploadUrl,
      objectPath: slot.objectPath,
      publicUrl: slot.publicUrl,
      dedupe: slot.dedupe,
    });
  } catch (err) {
    req.log.error({ err }, "Hub PNG upload slot reservation failed");
    if (err instanceof HubUploadError) {
      if (err.kind === "not_found") {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes("PRIVATE_OBJECT_DIR")) {
      res.status(503).json({ error: "App Storage not configured" });
      return;
    }
    res.status(500).json({ error: "Failed to reserve upload slot" });
  }
});

// ── Calculator push ────────────────────────────────────────────────────

router.post("/hub/calculator/push", async (req, res) => {
  const parsed = PushHubCalculatorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  try {
    const result = await pushCalcToInvoice({
      uploadId: body.uploadId,
      invoiceId: body.invoiceId,
      visualId: body.visualId,
      rangeKey: body.rangeKey,
      priceRows: body.priceRows,
      quoteNumber: String(body.visualId),
      lineItem: body.lineItem ?? null,
      noteSections: body.noteSections ?? null,
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Hub calculator push failed");
    if (err instanceof CalcPushError) {
      if (err.kind === "not_found") {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err.kind === "invalid") {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err.kind === "upload_not_ready") {
        res.status(422).json({ error: err.message });
        return;
      }
      if (err.kind === "conflict" || err.kind === "locked") {
        res.status(409).json({ error: err.message });
        return;
      }
    }
    if (err instanceof HubUploadError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes("PRINTAVO_API")) {
      res.status(503).json({ error: "Printavo not configured" });
      return;
    }
    res.status(500).json({ error: "Calculator push failed" });
  }
});

// ── Multi-style handoff (one new group or one new quote) ───────────────

function handoffError(req: { log: { error: (o: object, m: string) => void } }, res: import("express").Response, err: unknown) {
  if (err instanceof HandoffValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof HandoffConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  req.log.error({ err }, "Hub calculator handoff failed");
  if (err instanceof Error && err.message.includes("PRINTAVO_API")) {
    res.status(503).json({ error: "Printavo not configured" });
    return;
  }
  res.status(500).json({ error: "Calculator handoff failed. Nothing is retried automatically." });
}

router.post("/hub/calculator/handoff/preview", async (req, res) => {
  const parsed = PreviewHubCalculatorHandoffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid handoff request", details: parsed.error.issues });
    return;
  }
  try {
    res.json(await previewHandoff(parsed.data));
  } catch (err) {
    handoffError(req, res, err);
  }
});

router.post("/hub/calculator/handoff/commit", async (req, res) => {
  const parsed = CommitHubCalculatorHandoffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid handoff request", details: parsed.error.issues });
    return;
  }
  try {
    res.json(await commitHandoff(parsed.data, req.staff?.email ?? null));
  } catch (err) {
    handoffError(req, res, err);
  }
});

export default router;
