import { Router } from "express";
import { pool } from "@workspace/db";
import { z } from "zod";
import { day } from "../lib/sales/policy";
import { salesWorkspace } from "../lib/sales/workspace";
import { salesHistory } from "../lib/sales/history";
import { saveRecord, archiveRecord, SalesError } from "../lib/sales/store";

const router = Router();
const filterSchema = z.object({
  from: day, to: day, customerId: z.string().regex(/^\d+$/).optional(),
  owner: z.string().max(320).transform(v => v.toLowerCase()).optional(),
  nicheId: z.string().uuid().optional(),
}).refine(v => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 3660 * 86400000, "Choose an ordered range of at most ten years");
function error(req: any, res: any, err: unknown) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map(i => i.message).join("; ") });
  if (err instanceof SalesError) return res.status(err.status).json({ error: err.message });
  if ((err as any)?.code === "23505") return res.status(409).json({ error: "This record or follow-up already exists. Reload to edit it instead." });
  req.log.error({ err }, "Sales follow-up request failed");
  return res.status(500).json({ error: "Unable to complete the sales request" });
}
router.get("/customers/sales/workspace", async (req, res) => {
  try { res.json(await salesWorkspace(filterSchema.parse(req.query))); }
  catch (err) { error(req, res, err); }
});
router.get("/customers/sales/history", async (req, res) => {
  try {
    const filter = filterSchema.parse(req.query);
    const extras = z.object({ dateBasis: z.enum(["invoice", "customerDue"]).optional(), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).parse(req.query);
    res.json(await salesHistory({ ...filter, ...extras }));
  } catch (err) { error(req, res, err); }
});
for (const [path, handler] of [["save", saveRecord], ["archive", archiveRecord]] as const) {
  router.post(`/customers/sales/${path}`, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await handler(client, req.body, req.staff!.email, req.staff?.role === "admin");
      await client.query("COMMIT");
      res.json(result);
    } catch (err) {
      await client.query("ROLLBACK");
      error(req, res, err);
    } finally { client.release(); }
  });
}
export default router;
