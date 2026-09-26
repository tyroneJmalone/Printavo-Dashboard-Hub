import type { NextFunction, Request, Response } from "express";
import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Per-module access gating — "readiness switches" for the Hub.
 *
 * An admin flips modules on/off in Settings; non-admin staff (staff AND
 * manager roles) only see and reach modules that are switched ON. Admins
 * always have everything. Default is everything OFF, so a freshly invited
 * teammate sees nothing until Tyler enables the modules that are ready.
 *
 * This is a readiness gate, not a data-permission system — sensitive data
 * remains guarded by the existing role/capability checks (email ACLs,
 * admin-only routes, the admin PIN). Several modules intentionally claim
 * the same API prefix (e.g. Product Finder and Purchasing both need
 * /purchasing/*): a prefix is reachable when ANY claiming module is
 * enabled.
 */

export interface ModuleDef {
  key: string;
  label: string;
  /** Sidebar group heading, mirrored in the settings UI. */
  group: string;
  /** First path segments of API routes this module needs. */
  apiPrefixes: readonly string[];
}

export const MODULE_DEFS: readonly ModuleDef[] = [
  { key: "printscope", label: "SepScope", group: "Production", apiPrefixes: ["/printscope"] },
  { key: "dashboard", label: "Dashboard", group: "General", apiPrefixes: ["/dashboard"] },
  { key: "reports", label: "Reports", group: "Analyze", apiPrefixes: ["/reports"] },
  { key: "payments", label: "Payments", group: "Analyze", apiPrefixes: ["/reports"] },
  { key: "ask-ai", label: "Ask AI", group: "Analyze", apiPrefixes: ["/insights"] },
  { key: "knowledge", label: "Knowledge Base", group: "Analyze", apiPrefixes: ["/knowledge"] },
  { key: "correspondence", label: "Correspondence", group: "Analyze", apiPrefixes: ["/correspondence"] },
  { key: "product-finder", label: "Product Finder", group: "Sales", apiPrefixes: ["/purchasing"] },
  { key: "garment-pantones", label: "Garment Pantones", group: "Sales", apiPrefixes: ["/purchasing"] },
  { key: "collections", label: "Collections", group: "Sales", apiPrefixes: ["/collections"] },
  { key: "pipeline", label: "Pipeline", group: "Sales", apiPrefixes: ["/pipeline", "/reports"] },
  { key: "status-activity", label: "Status Activity", group: "Sales", apiPrefixes: ["/status-activity", "/reports"] },
  { key: "chipply", label: "Chipply Stores", group: "Sales", apiPrefixes: ["/chipply"] },
  { key: "reorder", label: "Reorder Requests", group: "Sales", apiPrefixes: ["/reorder-requests"] },
  { key: "customers", label: "Client Directory & Niche Report", group: "Clients", apiPrefixes: ["/customers", "/branding"] },
  { key: "purchasing", label: "Vendor Orders, PO Log & Tracking", group: "Purchasing", apiPrefixes: ["/purchasing"] },
  { key: "production", label: "Print Queue & Automation", group: "Production", apiPrefixes: ["/print-queue"] },
  { key: "ai-quotes", label: "AI Quote Drafts", group: "Quoting", apiPrefixes: ["/quote-drafts"] },
  { key: "price-calculator", label: "Price Calculator", group: "Quoting", apiPrefixes: ["/pricing", "/hub"] },
  { key: "momintum", label: "Tasks (moMINTum)", group: "Team", apiPrefixes: ["/momintum", "/printavo-tasks"] },
  { key: "shipping", label: "Rate Estimator & Label Sorter", group: "Shipping", apiPrefixes: ["/shipping", "/sorter"] },
  { key: "mintbucks", label: "Mint Bucks", group: "Mint Bucks", apiPrefixes: ["/mintbucks"] },
  { key: "backups", label: "Backups", group: "Data", apiPrefixes: ["/backup"] },
] as const;

export const MODULE_KEYS: readonly string[] = MODULE_DEFS.map((m) => m.key);
const VALID_KEYS = new Set(MODULE_KEYS);

/** prefix (first path segment, e.g. "/reports") → module keys claiming it. */
const PREFIX_CLAIMS = new Map<string, string[]>();
for (const def of MODULE_DEFS) {
  for (const prefix of def.apiPrefixes) {
    const list = PREFIX_CLAIMS.get(prefix) ?? [];
    list.push(def.key);
    PREFIX_CLAIMS.set(prefix, list);
  }
}

const SETTINGS_KEY = "module_access";

interface StoredModuleAccess {
  enabled: string[];
}

/** Short-lived cache so the gate doesn't add a query to every request.
 *  Writes update it immediately; other server instances converge in <10s. */
let cache: { enabled: Set<string>; at: number } | null = null;
const CACHE_TTL_MS = 10_000;

export async function getEnabledModuleKeys(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.enabled;
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, SETTINGS_KEY))
    .limit(1);
  const stored = rows[0]?.value as StoredModuleAccess | undefined;
  const enabled = new Set(
    (stored?.enabled ?? []).filter((k) => VALID_KEYS.has(k)),
  );
  cache = { enabled, at: Date.now() };
  return enabled;
}

export async function setEnabledModuleKeys(keys: string[]): Promise<Set<string>> {
  const enabled = [...new Set(keys.filter((k) => VALID_KEYS.has(k)))];
  const value: StoredModuleAccess = { enabled };
  await db
    .insert(appSettingsTable)
    .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
  const set = new Set(enabled);
  cache = { enabled: set, at: Date.now() };
  return set;
}

export function isValidModuleKey(key: string): boolean {
  return VALID_KEYS.has(key);
}

/**
 * Module gate for non-admin staff — mount AFTER requireStaff.
 *
 * Paths whose first segment is claimed by at least one module require at
 * least one claiming module to be enabled. Unclaimed paths (auth/me, sync
 * status bar, staff-management, email-activity…) pass through to their
 * existing role/capability guards.
 */
export async function moduleAccessGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const staff = req.staff;
    if (!staff || staff.role === "admin") {
      next();
      return;
    }
    const firstSegment = "/" + (req.path.split("/")[1] ?? "");
    const claimants = PREFIX_CLAIMS.get(firstSegment);
    if (!claimants) {
      next();
      return;
    }
    const enabled = await getEnabledModuleKeys();
    if (claimants.some((key) => enabled.has(key))) {
      next();
      return;
    }
    res.status(403).json({
      error: "This module isn't enabled for your account yet.",
      code: "module_disabled",
    });
  } catch (err) {
    req.log.error({ err }, "module access check failed");
    res.status(500).json({ error: "Module access check failed" });
  }
}
