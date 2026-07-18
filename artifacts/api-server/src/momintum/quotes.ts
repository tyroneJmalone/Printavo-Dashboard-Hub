import { Router, type IRouter } from "express";
import { db, quotesTable } from "@workspace/momintum-db";
import { eq } from "drizzle-orm";
import { CreateQuoteBody, DeleteQuoteParams } from "@workspace/api-zod";
import { requireAdmin } from "./auth";

const router: IRouter = Router();

router.get("/quotes", async (_req, res): Promise<void> => {
  const quotes = await db
    .select()
    .from(quotesTable)
    .orderBy(quotesTable.createdAt);
  res.json(quotes);
});

// NOTE: POST /quotes/seed-if-empty is intentionally NOT ported — the live
// database is already seeded and owned by the standalone app.

router.post("/quotes", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [quote] = await db.insert(quotesTable).values(parsed.data).returning();

  res.status(201).json(quote);
});

router.delete("/quotes/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(quotesTable)
    .where(eq(quotesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }

  res.status(204).send();
});

export default router;
