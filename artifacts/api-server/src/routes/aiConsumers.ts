import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  aiAuditEventsTable,
  aiConsumersTable,
  type AiConsumer,
} from "@workspace/db";
import {
  CreateAiConsumerBody,
  CreateAiConsumerResponse,
  GetAiContextSettingsResponse,
  ListAiAuditEventsQueryParams,
  ListAiAuditEventsResponse,
  ListAiConsumersResponse,
  ReviewAiAuditEventBody,
  ReviewAiAuditEventParams,
  ReviewAiAuditEventResponse,
  RevokeAiConsumerParams,
  RevokeAiConsumerResponse,
  UpdateAiConsumerBody,
  UpdateAiConsumerParams,
  UpdateAiConsumerResponse,
  UpdateAiContextSettingsBody,
  UpdateAiContextSettingsResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { generateConsumerToken } from "../lib/contextCore/auth";
import {
  getAiGuardrailSettings,
  setAiGuardrailSettings,
} from "../lib/aiGuardrails";

/**
 * Admin management of AI context consumers (tokens), the shared audit
 * log with accuracy scoring / usage feedback, and the guardrail kill
 * switch. Everything here is admin-only — tokens grant machine access to
 * company data.
 */
const router: IRouter = Router();
router.use("/ai-context", requireAdmin);

function consumerDto(row: AiConsumer) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    tokenPrefix: row.tokenPrefix,
    tier: row.tier,
    scopes: row.scopes,
    rateLimitPerMin: row.rateLimitPerMin,
    active: row.active,
    createdByEmail: row.createdByEmail,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

router.get("/ai-context/consumers", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(aiConsumersTable)
    .orderBy(desc(aiConsumersTable.createdAt));
  res.json(ListAiConsumersResponse.parse(rows.map(consumerDto)));
});

router.post("/ai-context/consumers", async (req, res): Promise<void> => {
  const parsed = CreateAiConsumerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { token, tokenHash, tokenPrefix } = generateConsumerToken();
  const [row] = await db
    .insert(aiConsumersTable)
    .values({
      name: parsed.data.name,
      platform: parsed.data.platform ?? "",
      tokenHash,
      tokenPrefix,
      tier: parsed.data.tier ?? "internal",
      scopes: parsed.data.scopes && parsed.data.scopes.length > 0 ? parsed.data.scopes : ["*"],
      rateLimitPerMin: parsed.data.rateLimitPerMin ?? 60,
      createdByEmail: req.staff!.email,
    })
    .returning()
    .catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("ai_consumers_name_ux")) {
        return [];
      }
      throw err;
    });
  if (!row) {
    res.status(400).json({ error: "A consumer with this name already exists" });
    return;
  }
  req.log.info(
    { consumerId: row.id, name: row.name, tier: row.tier, by: req.staff!.email },
    "AI context consumer created",
  );
  res
    .status(201)
    .json(CreateAiConsumerResponse.parse({ consumer: consumerDto(row), token }));
});

router.patch("/ai-context/consumers/:id", async (req, res): Promise<void> => {
  const params = UpdateAiConsumerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAiConsumerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(aiConsumersTable)
    .set({
      ...(parsed.data.platform !== undefined ? { platform: parsed.data.platform } : {}),
      ...(parsed.data.scopes !== undefined ? { scopes: parsed.data.scopes } : {}),
      ...(parsed.data.rateLimitPerMin !== undefined
        ? { rateLimitPerMin: parsed.data.rateLimitPerMin }
        : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      updatedAt: new Date(),
    })
    .where(eq(aiConsumersTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Consumer not found" });
    return;
  }
  req.log.info({ consumerId: row.id, by: req.staff!.email }, "AI context consumer updated");
  res.json(UpdateAiConsumerResponse.parse(consumerDto(row)));
});

router.post("/ai-context/consumers/:id/revoke", async (req, res): Promise<void> => {
  const params = RevokeAiConsumerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .update(aiConsumersTable)
    .set({ active: false, revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(aiConsumersTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Consumer not found" });
    return;
  }
  req.log.info({ consumerId: row.id, by: req.staff!.email }, "AI context consumer revoked");
  res.json(RevokeAiConsumerResponse.parse(consumerDto(row)));
});

router.get("/ai-context/audit", async (req, res): Promise<void> => {
  const query = ListAiAuditEventsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions = [];
  if (query.data.consumerId) {
    conditions.push(eq(aiAuditEventsTable.consumerId, query.data.consumerId));
  }
  if (query.data.tool) {
    conditions.push(eq(aiAuditEventsTable.tool, query.data.tool));
  }
  const rows = await db
    .select()
    .from(aiAuditEventsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(aiAuditEventsTable.createdAt))
    .limit(query.data.limit ?? 50);
  res.json(ListAiAuditEventsResponse.parse(rows));
});

router.post("/ai-context/audit/:id/review", async (req, res): Promise<void> => {
  const params = ReviewAiAuditEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = ReviewAiAuditEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(aiAuditEventsTable)
    .set({
      ...(parsed.data.accuracy !== undefined ? { accuracy: parsed.data.accuracy } : {}),
      ...(parsed.data.feedbackOutcome !== undefined
        ? { feedbackOutcome: parsed.data.feedbackOutcome }
        : {}),
      ...(parsed.data.feedbackNote !== undefined
        ? { feedbackNote: parsed.data.feedbackNote }
        : {}),
      reviewedByEmail: req.staff!.email,
      reviewedAt: new Date(),
    })
    .where(eq(aiAuditEventsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Audit event not found" });
    return;
  }
  res.json(ReviewAiAuditEventResponse.parse(row));
});

router.get("/ai-context/settings", async (_req, res): Promise<void> => {
  const settings = await getAiGuardrailSettings({ force: true });
  res.json(GetAiContextSettingsResponse.parse(settings));
});

router.put("/ai-context/settings", async (req, res): Promise<void> => {
  const parsed = UpdateAiContextSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const settings = await setAiGuardrailSettings(parsed.data);
  req.log.warn(
    { contextLayerEnabled: settings.contextLayerEnabled, by: req.staff!.email },
    "AI context kill switch changed",
  );
  res.json(UpdateAiContextSettingsResponse.parse(settings));
});

export default router;
