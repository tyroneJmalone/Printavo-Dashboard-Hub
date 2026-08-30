import { eq } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";

/**
 * Shared AI guardrail settings (kill switches) stored in app_settings.
 * Built as a shared module so every Hub AI surface (context layer doors,
 * Ask AI, quote extraction, correspondence search) can adopt the same
 * switch store instead of growing bespoke flags.
 */
const SETTINGS_KEY = "ai_guardrails";
const CACHE_TTL_MS = 10_000;

export interface AiGuardrailSettings {
  /** Master switch for the AI context layer doors (MCP + REST). */
  contextLayerEnabled: boolean;
}

const DEFAULTS: AiGuardrailSettings = { contextLayerEnabled: true };

let cache: { value: AiGuardrailSettings; at: number } | null = null;

export async function getAiGuardrailSettings(
  opts: { force?: boolean } = {},
): Promise<AiGuardrailSettings> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, SETTINGS_KEY));
  const stored = (row?.value ?? {}) as Partial<AiGuardrailSettings>;
  const value: AiGuardrailSettings = {
    contextLayerEnabled:
      typeof stored.contextLayerEnabled === "boolean"
        ? stored.contextLayerEnabled
        : DEFAULTS.contextLayerEnabled,
  };
  cache = { value, at: Date.now() };
  return value;
}

export async function setAiGuardrailSettings(
  patch: Partial<AiGuardrailSettings>,
): Promise<AiGuardrailSettings> {
  const current = await getAiGuardrailSettings({ force: true });
  const next: AiGuardrailSettings = { ...current, ...patch };
  await db
    .insert(appSettingsTable)
    .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value: next, updatedAt: new Date() },
    });
  cache = { value: next, at: Date.now() };
  return next;
}

export async function isContextLayerEnabled(): Promise<boolean> {
  return (await getAiGuardrailSettings()).contextLayerEnabled;
}
