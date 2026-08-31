import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, draftBacktestItemsTable, type DraftBacktestItem, type DraftBacktestRun } from "@workspace/db";
import {
  ListDraftBacktestRunsQueryParams,
  ListDraftBacktestRunsResponse,
  StartDraftBacktestRunBody,
  StartDraftBacktestRunResponse,
  ListDraftBacktestItemsParams,
  ListDraftBacktestItemsResponse,
  ReviewDraftBacktestItemParams,
  ReviewDraftBacktestItemBody,
  ReviewDraftBacktestItemResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import {
  listBacktestItems,
  listBacktestRuns,
  startBacktestRun,
} from "../lib/draftBacktest/service";

/**
 * Offline drafting backtest (admin, AI Connections page): dry-run AI drafts
 * over historical answered email and score them against the reply the
 * teammate actually sent. Never writes to Missive.
 */
const router: IRouter = Router();
router.use("/ai-context/backtest", requireAdmin);

function runDto(run: DraftBacktestRun) {
  return {
    id: run.id,
    status: run.status,
    requestedByEmail: run.requestedByEmail,
    samplePerMailbox: run.samplePerMailbox,
    itemsTotal: run.itemsTotal,
    itemsDone: run.itemsDone,
    itemsFailed: run.itemsFailed,
    skippedMailboxes: run.skippedMailboxes,
    model: run.model,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function itemDto(item: DraftBacktestItem, mailboxEmail: string) {
  return {
    id: item.id,
    runId: item.runId,
    mailboxId: item.mailboxId,
    mailboxEmail,
    subject: item.subject,
    counterpartEmail: item.counterpartEmail,
    counterpartName: item.counterpartName,
    customerId: item.customerId,
    customerName: item.customerName,
    inboundAt: item.inboundAt.toISOString(),
    inboundText: item.inboundText,
    replyAt: item.replyAt.toISOString(),
    replyText: item.replyText,
    factsMarkdown: item.factsMarkdown,
    voiceDraftBody: item.voiceDraftBody,
    genericDraftBody: item.genericDraftBody,
    status: item.status,
    error: item.error,
    factAccuracy: item.factAccuracy,
    voiceVerdict: item.voiceVerdict,
    wouldUse: item.wouldUse,
    reviewNote: item.reviewNote,
    reviewedByEmail: item.reviewedByEmail,
    reviewedAt: item.reviewedAt?.toISOString() ?? null,
  };
}

router.get("/ai-context/backtest/runs", async (req, res): Promise<void> => {
  const parsed = ListDraftBacktestRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const runs = await listBacktestRuns(parsed.data.limit ?? 20);
  res.json(ListDraftBacktestRunsResponse.parse(runs.map(runDto)));
});

router.post("/ai-context/backtest/runs", async (req, res): Promise<void> => {
  const body = StartDraftBacktestRunBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const result = await startBacktestRun({
    samplePerMailbox: body.data.samplePerMailbox,
    requestedByEmail: req.staff?.email ?? null,
    log: req.log,
  });
  if ("error" in result) {
    res.status(409).json({ error: result.error });
    return;
  }
  req.log.info(
    { runId: result.run.id, by: req.staff?.email, samplePerMailbox: body.data.samplePerMailbox },
    "draft backtest started",
  );
  res.status(202).json(StartDraftBacktestRunResponse.parse(runDto(result.run)));
});

router.get("/ai-context/backtest/runs/:id/items", async (req, res): Promise<void> => {
  const params = ListDraftBacktestItemsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await listBacktestItems(params.data.id);
  res.json(ListDraftBacktestItemsResponse.parse(rows.map((r) => itemDto(r.item, r.mailboxEmail))));
});

router.patch("/ai-context/backtest/items/:id", async (req, res): Promise<void> => {
  const params = ReviewDraftBacktestItemParams.safeParse(req.params);
  const body = ReviewDraftBacktestItemBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.success ? body : params).error?.message });
    return;
  }
  const [item] = await db
    .update(draftBacktestItemsTable)
    .set({
      ...(body.data.factAccuracy !== undefined ? { factAccuracy: body.data.factAccuracy } : {}),
      ...(body.data.voiceVerdict !== undefined ? { voiceVerdict: body.data.voiceVerdict } : {}),
      ...(body.data.wouldUse !== undefined ? { wouldUse: body.data.wouldUse } : {}),
      ...(body.data.reviewNote !== undefined ? { reviewNote: body.data.reviewNote } : {}),
      reviewedByEmail: req.staff?.email ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(draftBacktestItemsTable.id, params.data.id))
    .returning();
  if (!item) {
    res.status(404).json({ error: "Backtest item not found" });
    return;
  }
  const rows = await listBacktestItems(item.runId);
  const match = rows.find((r) => r.item.id === item.id);
  res.json(
    ReviewDraftBacktestItemResponse.parse(itemDto(item, match?.mailboxEmail ?? "")),
  );
});

export default router;
