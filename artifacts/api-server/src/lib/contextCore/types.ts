import type { z } from "zod";

/**
 * Protocol-independent core of the AI context layer ("one core, many
 * doors"). Doors (MCP, REST, direct internal calls) translate transport
 * details into a ContextCaller + tool call; everything else — trust tiers,
 * scopes, rate limits, kill switch, caching, auditing — lives here and is
 * identical no matter which door was used.
 */
export type ConsumerTier = "internal" | "external";

export interface ContextCaller {
  /** ai_consumers.id — null for direct internal (staff/Hub module) calls. */
  consumerId: string | null;
  name: string;
  tier: ConsumerTier;
  /** Tool names the caller may use; ["*"] = every tier-allowed tool. */
  scopes: string[];
  rateLimitPerMin: number;
  /** Set when a staff session (internal surface) is behind the call. */
  staffEmail?: string | null;
}

export interface ContextTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  allowedTiers: ConsumerTier[];
  /** Action tools create human-reviewed drafts; they are never cached. */
  isAction: boolean;
  /** Short-TTL cache for hot lookups; 0 disables caching. */
  cacheTtlSeconds: number;
  handler: (args: Record<string, unknown>, caller: ContextCaller) => Promise<unknown>;
}

export type ContextToolResult =
  | { ok: true; data: unknown; cached: boolean; auditEventId: string | null }
  | {
      ok: false;
      errorCode:
        | "CONTEXT_DISABLED"
        | "UNKNOWN_TOOL"
        | "FORBIDDEN_TIER"
        | "FORBIDDEN_SCOPE"
        | "RATE_LIMITED"
        | "INVALID_ARGS"
        | "TOOL_ERROR";
      message: string;
      retryAfterSeconds?: number;
      auditEventId?: string | null;
    };
