import { checkRateLimit } from "../aiGuardrails/rateLimit";
import { isContextLayerEnabled } from "../aiGuardrails/killSwitch";
import { recordAiAuditEvent } from "../aiGuardrails/audit";
import { logger } from "../logger";
import { cacheGet, cacheSet } from "./cache";
import { findContextTool } from "./tools";
import type { ContextCaller, ContextToolResult } from "./types";

/**
 * The single execution path for every context tool call, regardless of
 * door: kill switch → tool lookup → trust tier → scope → rate limit →
 * input validation → (cache) → handler → audit. Every call — success,
 * failure, or cache hit — lands in ai_audit_events.
 */
export async function executeContextTool(input: {
  caller: ContextCaller;
  surface: "context_mcp" | "context_rest" | "context_internal";
  tool: string;
  args: unknown;
}): Promise<ContextToolResult> {
  const { caller, surface, tool: toolName } = input;
  const startedAt = Date.now();

  const audit = async (
    ok: boolean,
    errorCode: string | null,
    resultSummary: string,
  ) =>
    recordAiAuditEvent({
      surface,
      consumerId: caller.consumerId,
      consumerName: caller.name,
      staffEmail: caller.staffEmail ?? null,
      tool: toolName,
      input: input.args,
      ok,
      errorCode,
      resultSummary,
      latencyMs: Date.now() - startedAt,
    });

  if (!(await isContextLayerEnabled())) {
    const auditEventId = await audit(false, "CONTEXT_DISABLED", "kill switch off");
    return {
      ok: false,
      errorCode: "CONTEXT_DISABLED",
      message: "The AI context layer is currently disabled by an administrator.",
      auditEventId,
    };
  }

  const tool = findContextTool(toolName);
  if (!tool) {
    const auditEventId = await audit(false, "UNKNOWN_TOOL", "");
    return { ok: false, errorCode: "UNKNOWN_TOOL", message: `Unknown tool: ${toolName}`, auditEventId };
  }
  if (!tool.allowedTiers.includes(caller.tier)) {
    const auditEventId = await audit(false, "FORBIDDEN_TIER", "");
    return {
      ok: false,
      errorCode: "FORBIDDEN_TIER",
      message: `Tool ${toolName} is not available to ${caller.tier}-tier consumers.`,
      auditEventId,
    };
  }
  if (!caller.scopes.includes("*") && !caller.scopes.includes(toolName)) {
    const auditEventId = await audit(false, "FORBIDDEN_SCOPE", "");
    return {
      ok: false,
      errorCode: "FORBIDDEN_SCOPE",
      message: `This consumer's token does not include the ${toolName} scope.`,
      auditEventId,
    };
  }

  const rateKey = caller.consumerId ?? `internal:${caller.staffEmail ?? caller.name}`;
  const rate = checkRateLimit(rateKey, caller.rateLimitPerMin);
  if (!rate.allowed) {
    const auditEventId = await audit(false, "RATE_LIMITED", "");
    return {
      ok: false,
      errorCode: "RATE_LIMITED",
      message: `Rate limit reached (${caller.rateLimitPerMin}/min). Retry in ${rate.retryAfterSeconds}s.`,
      retryAfterSeconds: rate.retryAfterSeconds,
      auditEventId,
    };
  }

  const parsed = tool.schema.safeParse(input.args ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    const auditEventId = await audit(false, "INVALID_ARGS", message.slice(0, 300));
    return { ok: false, errorCode: "INVALID_ARGS", message, auditEventId };
  }

  const cacheKey =
    tool.cacheTtlSeconds > 0 && !tool.isAction
      ? `${toolName}:${JSON.stringify(parsed.data)}`
      : null;
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached.hit) {
      const auditEventId = await audit(true, null, "cache hit");
      return { ok: true, data: cached.value, cached: true, auditEventId };
    }
  }

  try {
    const data = await tool.handler(parsed.data, caller);
    if (cacheKey) cacheSet(cacheKey, data, tool.cacheTtlSeconds);
    const summary = summarizeResult(toolName, data);
    const auditEventId = await audit(true, null, summary);
    return { ok: true, data, cached: false, auditEventId };
  } catch (err) {
    logger.error({ err, tool: toolName, consumer: caller.name }, "context tool failed");
    const auditEventId = await audit(false, "TOOL_ERROR", err instanceof Error ? err.message.slice(0, 300) : "");
    return {
      ok: false,
      errorCode: "TOOL_ERROR",
      message: "The tool failed to execute. The failure has been logged.",
      auditEventId,
    };
  }
}

function summarizeResult(tool: string, data: unknown): string {
  try {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d?.candidates)) return `${(d.candidates as unknown[]).length} candidates`;
    if (Array.isArray(d?.orders)) return `${(d.orders as unknown[]).length} orders`;
    if (Array.isArray(d?.entries)) return `${(d.entries as unknown[]).length} entries`;
    if (d?.found === false) return "not found";
    if (typeof d?.draftId === "string") return `draft ${d.draftId}`;
    if (d?.found === true) return "found";
    return "ok";
  } catch {
    return "ok";
  }
}
