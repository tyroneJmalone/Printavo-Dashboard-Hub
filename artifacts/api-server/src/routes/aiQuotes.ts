import {
  CreatePrintavoQuoteFromDraftBody,
  InterpretAiQuotePromptBody,
  UpdateAiQuoteDraftBody,
} from "@workspace/api-zod";
import type { AiQuoteDraftData } from "@workspace/db";
import { Router, type IRouter } from "express";
import { QuoteExtractionError } from "../lib/quoteDrafts/extract";
import {
  QuoteDraftConflictError,
  QuoteDraftValidationError,
  createPrintavoQuote,
  getQuoteDraft,
  interpretAndCreateDraft,
  listQuoteDrafts,
  searchQuoteCustomers,
  updateQuoteDraft,
} from "../lib/quoteDrafts/service";

const router: IRouter = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/quote-drafts", async (_req, res) => {
  try {
    res.json({ drafts: await listQuoteDrafts() });
  } catch (err) {
    _req.log.error({ err }, "AI quote draft list failed");
    res.status(500).json({ error: "Failed to load quote drafts" });
  }
});

router.post("/quote-drafts", async (req, res) => {
  const parsed = InterpretAiQuotePromptBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Prompt must be 8-10,000 characters" });
    return;
  }
  try {
    const draft = await interpretAndCreateDraft(
      parsed.data.prompt.trim(),
      req.staff?.email ?? null,
    );
    res.status(201).json(draft);
  } catch (err) {
    req.log.error({ err }, "AI quote prompt interpretation failed");
    if (err instanceof QuoteExtractionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(503).json({
      error: "Quote interpretation is temporarily unavailable. No draft was created.",
    });
  }
});

router.get("/quote-drafts/customers/search", async (req, res) => {
  const query = typeof req.query.query === "string"
    ? req.query.query.trim()
    : "";
  if (query.length < 2 || query.length > 100) {
    res.status(400).json({ error: "Search must be 2-100 characters." });
    return;
  }
  try {
    res.json({ customers: await searchQuoteCustomers(query) });
  } catch (err) {
    req.log.error({ err, query }, "AI quote customer search failed");
    res.status(500).json({ error: "Failed to search Printavo customers" });
  }
});

router.get("/quote-drafts/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }
  try {
    const draft = await getQuoteDraft(req.params.id);
    if (!draft) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    res.json(draft);
  } catch (err) {
    req.log.error({ err, id: req.params.id }, "AI quote draft load failed");
    res.status(500).json({ error: "Failed to load quote draft" });
  }
});

router.put("/quote-drafts/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }
  const parsed = UpdateAiQuoteDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ??
        "The draft contains invalid or incomplete values.",
    });
    return;
  }
  try {
    const draft = await updateQuoteDraft(
      req.params.id,
      parsed.data.draft as AiQuoteDraftData,
      parsed.data.revision,
    );
    if (!draft) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    res.json(draft);
  } catch (err) {
    if (err instanceof QuoteDraftValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof QuoteDraftConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    req.log.error({ err, id: req.params.id }, "AI quote draft update failed");
    res.status(500).json({ error: "Failed to save quote draft" });
  }
});

router.post("/quote-drafts/:id/create-printavo", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }
  const parsed = CreatePrintavoQuoteFromDraftBody.safeParse(req.body);
  if (!parsed.success || parsed.data.confirmation !== "CONFIRM QUOTE") {
    res.status(400).json({ error: 'Type "CONFIRM QUOTE" to confirm.' });
    return;
  }
  try {
    const draft = await createPrintavoQuote(
      req.params.id,
      parsed.data.revision,
      req.staff?.email ?? null,
    );
    if (!draft) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    res.json(draft);
  } catch (err) {
    if (err instanceof QuoteDraftValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof QuoteDraftConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    req.log.error({ err, id: req.params.id }, "Printavo quote creation failed");
    res.status(500).json({ error: "Printavo quote creation failed" });
  }
});

export default router;