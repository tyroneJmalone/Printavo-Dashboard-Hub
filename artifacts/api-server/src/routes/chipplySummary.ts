import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { parseSummaryCsv } from "../lib/chipply/summaryImport";
import { previewSummary, confirmSummary, getStoreSummary, retainSummaryValue } from "../lib/chipply/summaryService";

const router = Router();
const base = "/chipply/summary";
router.use(base, (req, res, next) => {
  if (!req.staff) { res.status(401).json({ error: "Staff session required" }); return; }
  next();
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 1, fieldSize: 100 } }).single("file");
router.post(`${base}/preview`, (req, res) => {
  upload(req, res, async error => {
    if (error || !req.file) { res.status(400).json({ error: "Upload one CSV file up to 2 MB" }); return; }
    try {
      if (!/\.csv$/i.test(req.file.originalname)) throw new Error("Use a Store Summary CSV file");
      const scope = z.object({ expectedStoreId: z.string().uuid().optional() }).strict().parse(req.body ?? {});
      const text = new TextDecoder("utf-8", { fatal: true }).decode(req.file.buffer);
      const sources = parseSummaryCsv(text);
      const sourceName = req.file.originalname.split(/[/\\]/).pop()!.replace(/[\u0000-\u001f]/g, "").slice(0, 200);
      res.json(await previewSummary(sources, req.staff!.email, sourceName, scope.expectedStoreId));
    } catch (err) { req.log.warn({ errorName: (err as Error).name }, "Summary preview rejected"); res.status(400).json({ error: (err as Error).message }); }
  });
});
router.post(`${base}/confirm`, async (req, res) => {
  const parsed = z.object({ previewId: z.string().uuid(), selectedSalesOrders: z.array(z.string().regex(/^\d{5,7}$/)).min(1).max(2000).refine(ids => new Set(ids).size === ids.length) }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Select unique supported Sales Orders from the preview" }); return; }
  try { res.json(await confirmSummary(parsed.data.previewId, parsed.data.selectedSalesOrders, req.staff!.email)); }
  catch (err) { res.status(409).json({ error: (err as Error).message }); }
});
router.get(`${base}/stores/:id`, async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) { res.status(400).json({ error: "Invalid store ID" }); return; }
  try {
    const result = await getStoreSummary(String(req.params.id));
    if (!result) { res.status(404).json({ error: "Store not found" }); return; }
    res.json(result);
  } catch (err) { req.log.error({ err }, "Summary read failed"); res.status(500).json({ error: "Unable to load summary" }); }
});
router.post(`${base}/stores/:id/retain`, async (req, res) => {
  const parsed = z.object({ field: z.string().min(1).max(40), evidenceKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(req.body);
  if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) { res.status(400).json({ error: "Valid store, field and evidence key required" }); return; }
  try { res.json(await retainSummaryValue(String(req.params.id), parsed.data.field, parsed.data.evidenceKey, req.staff!.email)); }
  catch (err) { res.status(409).json({ error: (err as Error).message }); }
});
export default router;