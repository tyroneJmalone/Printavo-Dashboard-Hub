import { Router } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { getSetup } from "../lib/chipply/setup";

const router = Router();
const path = "/chipply/stores/:id/setup";
const request = z.object({
  version: z.number().int().min(0),
  currentStep: z.number().int().min(1).max(9),
  confirmedSteps: z.array(z.number().int().min(1).max(9)).max(9).refine(a => new Set(a).size === a.length),
  marginSkipped: z.boolean(), notes: z.string().max(4000),
  evidenceKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
router.use(path, (req, res, next) => {
  if (!req.staff) { res.status(401).json({ error: "Staff session required" }); return; }
  if (!z.string().uuid().safeParse(req.params.id).success) { res.status(400).json({ error: "Invalid store ID" }); return; }
  next();
});
router.get(path, async (req, res) => {
  try {
    const data = await getSetup(String(req.params.id));
    if (!data) { res.status(404).json({ error: "Store not found" }); return; }
    res.json(data);
  } catch (error) { req.log.error({ error }, "Chipply setup read failed"); res.status(500).json({ error: "Unable to load setup checks" }); }
});
router.put(path, async (req, res) => {
  const parsed = request.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid setup progress" }); return; }
  try {
    const id = String(req.params.id), data = parsed.data;
    const current = await getSetup(id);
    if (!current) { res.status(404).json({ error: "Store not found" }); return; }
    if (current.version !== data.version || current.evidenceKey !== data.evidenceKey) {
      res.status(409).json({ error: "Setup progress or source evidence changed. Refresh the guide and review the latest checks before saving." }); return;
    }
    const result = await pool.query(`INSERT INTO chipply_setup
      (store_id,current_step,version,confirmed_steps,margin_skipped,notes,evidence_key)
      VALUES($1,$2,1,$3::jsonb,$4,$5,$6)
      ON CONFLICT(store_id) DO UPDATE SET current_step=EXCLUDED.current_step,version=chipply_setup.version+1,
        confirmed_steps=EXCLUDED.confirmed_steps,margin_skipped=EXCLUDED.margin_skipped,
        notes=EXCLUDED.notes,evidence_key=EXCLUDED.evidence_key,updated_at=now()
      WHERE chipply_setup.version=$7 RETURNING store_id`,
    [id, data.currentStep, JSON.stringify(data.confirmedSteps), data.marginSkipped, data.notes, data.evidenceKey, data.version]);
    if (!result.rowCount) { res.status(409).json({ error: "Another staff member saved progress. Refresh before saving again." }); return; }
    res.json(await getSetup(id));
  } catch (error) { req.log.error({ error }, "Chipply setup save failed"); res.status(500).json({ error: "Unable to save setup progress" }); }
});
export default router;