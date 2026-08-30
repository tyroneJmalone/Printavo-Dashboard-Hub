import { db, aiAuditEventsTable } from "@workspace/db";
import { logger } from "../logger";

/**
 * Shared AI audit trail. Every AI tool call (context layer first; other
 * Hub AI surfaces can adopt it) records one event. Recording never throws —
 * an audit failure must not break the request — but failures are logged
 * loudly.
 */
export interface AiAuditInput {
  surface: string;
  consumerId?: string | null;
  consumerName?: string;
  staffEmail?: string | null;
  tool: string;
  /** Raw tool arguments; serialized + truncated before storage. */
  input: unknown;
  ok: boolean;
  errorCode?: string | null;
  resultSummary?: string;
  latencyMs?: number;
}

const MAX_INPUT_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 1_000;

function serializeInput(input: unknown): string {
  try {
    const text = JSON.stringify(input ?? {});
    return text.length > MAX_INPUT_CHARS
      ? `${text.slice(0, MAX_INPUT_CHARS)}…(truncated)`
      : text;
  } catch {
    return "(unserializable input)";
  }
}

/** Insert an audit event; returns the event id, or null when the insert failed. */
export async function recordAiAuditEvent(
  event: AiAuditInput,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(aiAuditEventsTable)
      .values({
        surface: event.surface,
        consumerId: event.consumerId ?? null,
        consumerName: event.consumerName ?? "",
        staffEmail: event.staffEmail ?? null,
        tool: event.tool,
        input: serializeInput(event.input),
        ok: event.ok,
        errorCode: event.errorCode ?? null,
        resultSummary: (event.resultSummary ?? "").slice(0, MAX_SUMMARY_CHARS),
        latencyMs: Math.max(0, Math.round(event.latencyMs ?? 0)),
      })
      .returning({ id: aiAuditEventsTable.id });
    return row?.id ?? null;
  } catch (err) {
    logger.error({ err, tool: event.tool, surface: event.surface }, "AI audit insert failed");
    return null;
  }
}
