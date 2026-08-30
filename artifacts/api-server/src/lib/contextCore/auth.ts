import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, aiConsumersTable, type AiConsumer } from "@workspace/db";
import { logger } from "../logger";
import type { ContextCaller, ConsumerTier } from "./types";

/**
 * Consumer token auth for the context layer doors. Raw tokens are shown
 * once at creation; only the sha256 hash is stored. The doors (MCP + REST)
 * authenticate with `Authorization: Bearer hubctx_...`.
 */
export function hashConsumerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateConsumerToken(): {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
} {
  const token = `hubctx_${randomBytes(24).toString("hex")}`;
  return {
    token,
    tokenHash: hashConsumerToken(token),
    tokenPrefix: token.slice(0, 15),
  };
}

const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

export async function resolveConsumerFromAuthHeader(
  header: string | undefined,
): Promise<AiConsumer | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!match) return null;
  const tokenHash = hashConsumerToken(match[1]!);
  const [consumer] = await db
    .select()
    .from(aiConsumersTable)
    .where(eq(aiConsumersTable.tokenHash, tokenHash));
  if (!consumer || !consumer.active || consumer.revokedAt) return null;

  const lastWrite = lastUsedWrites.get(consumer.id) ?? 0;
  if (Date.now() - lastWrite > LAST_USED_THROTTLE_MS) {
    lastUsedWrites.set(consumer.id, Date.now());
    db.update(aiConsumersTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(aiConsumersTable.id, consumer.id))
      .catch((err) => logger.warn({ err }, "ai consumer last_used update failed"));
  }
  return consumer;
}

export function callerFromConsumer(consumer: AiConsumer): ContextCaller {
  const tier: ConsumerTier = consumer.tier === "external" ? "external" : "internal";
  return {
    consumerId: consumer.id,
    name: consumer.name,
    tier,
    scopes: consumer.scopes,
    rateLimitPerMin: consumer.rateLimitPerMin,
    staffEmail: null,
  };
}

/** Caller identity for direct internal calls from Hub modules. */
export function internalCaller(staffEmail: string | null, label = "hub-internal"): ContextCaller {
  return {
    consumerId: null,
    name: label,
    tier: "internal",
    scopes: ["*"],
    rateLimitPerMin: 240,
    staffEmail,
  };
}
