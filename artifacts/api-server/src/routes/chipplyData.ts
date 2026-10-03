import { Router, type IRouter } from "express";
import multer from "multer";
import { z } from "zod";
import { MAX_DATA_BYTES } from "../lib/chipply/dataImport";
import { parseDataUpload } from "../lib/chipply/dataUpload";
import { previewChipplyData, confirmChipplyData, getChipplyDataDetail, overrideChipplyData } from "../lib/chipply/dataService";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DATA_BYTES, files: 1, fields: 1, fieldSize: 100 } }).single("file");
const base = "/chipply/data";
router.use(base, (req, res, next) => {
  if (!req.staff) { res.status(401).json({ error: "Staff session required" }); return; }
  next();
});
router.post(`${base}/preview`, (req, res) => {
  upload(req, res, async err => {
    if (err) { res.status(400).json({ error: "Upload one file, up to 5 MB, in multipart field file" }); return; }
    if (!req.file) { res.status(400).json({ error: "Data Export file required" }); return; }
    try {
      const scope = z.object({ expectedStoreId: z.string().uuid().optional() }).strict().parse(req.body ?? {});
      const parsed = await parseDataUpload(req.file.buffer, req.file.originalname);
      // Retain only a basename; no original file bytes or buyer contact data.
      const sourceName = req.file.originalname.split(/[/\\]/).pop()!.replace(/[\u0000-\u001f]/g, "").slice(0, 200);
      res.json(await previewChipplyData(parsed, req.staff!.email, sourceName, scope.expectedStoreId));
    } catch (error) {
      req.log.warn({ errorName: (error as Error).name }, "Chipply Data Export preview rejected");
      res.status(400).json({ error: (error as Error).message });
    }
  });
});
router.post(`${base}/confirm`, async (req, res) => {
  const body = z.object({ previewId: z.string().uuid(), replaceCurrent: z.boolean() }).strict().safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "previewId and explicit replaceCurrent boolean required" }); return; }
  try { res.json(await confirmChipplyData(body.data.previewId, req.staff!.email, body.data.replaceCurrent)); }
  catch (error) { res.status(409).json({ error: (error as Error).message }); }
});
router.get(`${base}/stores/:storeId`, async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.storeId).success) { res.status(400).json({ error: "Invalid store ID" }); return; }
  try {
    const detail = await getChipplyDataDetail(String(req.params.storeId));
    if (!detail) { res.status(404).json({ error: "No detailed Data Export imported for this store" }); return; }
    res.json(detail);
  } catch (error) { req.log.error({ errorName: (error as Error).name }, "Chipply data detail failed"); res.status(500).json({ error: "Unable to load Chipply data detail" }); }
});
router.post(`${base}/stores/:storeId/overrides`, async (req, res) => {
  const body = z.object({ snapshotId: z.string().uuid(), rowOrdinal: z.number().int().positive(), invoiceId: z.string().min(1).max(100), reason: z.string().trim().min(5).max(1000) }).strict().safeParse(req.body);
  if (!body.success || !z.string().uuid().safeParse(req.params.storeId).success) { res.status(400).json({ error: "Valid store, snapshot, row, invoice and review reason required" }); return; }
  try {
    const b = body.data;
    res.json(await overrideChipplyData(String(req.params.storeId), b.snapshotId, b.rowOrdinal, b.invoiceId, b.reason, req.staff!.email));
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});
export default router;