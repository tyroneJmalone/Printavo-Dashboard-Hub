import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { searchInvoice } from "../lib/printQueue/autoPrint/invoiceSearch";

export function createInvoiceSearchRouter(search = searchInvoice) {
  const router = Router();
  router.get("/print-queue/autoprint/invoice-search", requireAdmin, async (req, res) => {
    const input = z.object({
      invoice: z.string().regex(/^\d{1,12}$/),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
    }).safeParse(req.query);
    if (!input.success) { res.status(400).json({ error: "Enter an invoice number and a valid page offset." }); return; }
    try { res.json(await search(input.data.invoice, input.data.offset)); }
    catch (err) {
      req.log.error({ err }, "AutoPrint invoice search failed");
      res.status(500).json({ error: "Could not search AutoPrint history." });
    }
  });
  return router;
}
