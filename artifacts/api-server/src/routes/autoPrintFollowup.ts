import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { listFollowup, previewFollowup, confirmFollowup, reviewFollowup } from "../lib/printQueue/autoPrint/followup";

export function createAutoPrintFollowupRouter(deps = { listFollowup, previewFollowup, confirmFollowup, reviewFollowup }) {
  const router = Router();
  const root = "/print-queue/auto-print";
  router.post(`${root}/followup/:previewId/review`, requireAdmin, async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.previewId);
    const body = z.object({ jobIds: z.array(z.string().uuid()).length(1) }).safeParse(req.body);
    if (!id.success || !body.success) { res.status(400).json({ error: "Choose one held invoice to review." }); return; }
    try { res.json(await deps.reviewFollowup(id.data, body.data.jobIds, req.staff!.email)); }
    catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : "Could not verify the held correction." }); }
  });
  router.get(`${root}/runs/:runId/followup`, requireAdmin, async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.runId);
    if (!id.success) { res.status(400).json({ error: "Invalid run" }); return; }
    res.set("Cache-Control", "private, no-store");
    res.json(await deps.listFollowup(id.data));
  });
  router.post(`${root}/runs/:runId/followup/preview`, requireAdmin, async (req, res) => {
    const input = z.object({ jobIds: z.array(z.string().uuid()).min(1).max(20).refine(a => new Set(a).size === a.length) }).safeParse(req.body);
    const id = z.string().uuid().safeParse(req.params.runId);
    if (!input.success || !id.success) { res.status(400).json({ error: "Choose 1–20 unique accepted workorders." }); return; }
    try { res.json(await deps.previewFollowup(id.data, input.data.jobIds, req.staff!.email)); }
    catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : "Preview failed" }); }
  });
  router.post(`${root}/followup/:previewId/confirm`, requireAdmin, async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.previewId);
    if (!id.success) { res.status(400).json({ error: "Invalid preview" }); return; }
    try { res.json(await deps.confirmFollowup(id.data, req.staff!.email, req.log)); }
    catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : "Confirmation failed; review history before any further action." }); }
  });
  return router;
}
export default createAutoPrintFollowupRouter();
