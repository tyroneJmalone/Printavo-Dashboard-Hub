import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Admin PIN — gates destructive purchasing actions (vendor submit, admin
 * unlock, mark-failed) and its own rotation in Settings.
 *
 * Storage: app_settings key "admin_pin" as { sha256: <hex> } so the PIN can
 * be changed from the UI. The ADMIN_PIN env secret is a FALLBACK only used
 * while no database PIN exists (first run / fresh prod database); once a PIN
 * is saved in Settings the secret is ignored.
 *
 * Brute-force friction is process-wide and shared by every PIN-checking
 * route (including the change-PIN route): 5 wrong attempts → 15 minutes
 * locked. Reset on success or restart. This is an internal single-team app.
 */

const ADMIN_PIN_KEY = "admin_pin";
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type AdminPinSource = "database" | "secret" | null;

async function loadDbPinHash(): Promise<string | null> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, ADMIN_PIN_KEY))
    .limit(1);
  const value = rows[0]?.value as { sha256?: unknown } | undefined;
  return typeof value?.sha256 === "string" && SHA256_HEX.test(value.sha256)
    ? value.sha256
    : null;
}

/** Where the active PIN lives — database, the ADMIN_PIN secret, or nowhere. */
export async function getAdminPinSource(): Promise<AdminPinSource> {
  if (await loadDbPinHash()) return "database";
  if (process.env.ADMIN_PIN) return "secret";
  return null;
}

/** Constant-time PIN check against the database hash (or secret fallback). */
export async function adminPinMatches(pin: string): Promise<boolean> {
  const attempt = createHash("sha256").update(pin).digest();
  const dbHash = await loadDbPinHash();
  if (dbHash) return timingSafeEqual(attempt, Buffer.from(dbHash, "hex"));
  const expected = process.env.ADMIN_PIN;
  if (!expected) return false;
  return timingSafeEqual(attempt, createHash("sha256").update(expected).digest());
}

/** Store a new PIN (sha256 hex) in app_settings — takes effect immediately. */
export async function setAdminPin(newPin: string): Promise<void> {
  const value = { sha256: createHash("sha256").update(newPin).digest("hex") };
  await db
    .insert(appSettingsTable)
    .values({ key: ADMIN_PIN_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

// ── Shared lockout state ─────────────────────────────────────────────
const PIN_MAX_FAILURES = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
let pinFailures = 0;
let pinLockedUntil = 0;

export function pinLockoutRemainingMs(): number {
  return Math.max(0, pinLockedUntil - Date.now());
}

/** Record a wrong attempt. Returns true if this attempt triggered lockout. */
export function registerPinFailure(): boolean {
  pinFailures += 1;
  if (pinFailures >= PIN_MAX_FAILURES) {
    pinLockedUntil = Date.now() + PIN_LOCKOUT_MS;
    pinFailures = 0;
    return true;
  }
  return false;
}

export function resetPinLockout(): void {
  pinFailures = 0;
  pinLockedUntil = 0;
}

function sendLockout(res: Response, remainingMs: number): void {
  const mins = Math.ceil(remainingMs / 60_000);
  res.status(429).json({
    error: `Too many wrong PIN attempts — try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
  });
}

/**
 * Full PIN gate for a route: configured? → not locked out? → PIN correct?
 * Sends the error response itself and returns false on any failure — the
 * caller just returns. Never throws (DB errors become a 500 here).
 */
export async function requireValidAdminPin(
  req: Request,
  res: Response,
  pin: string | undefined,
  action: string,
  logMeta: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    if ((await getAdminPinSource()) === null) {
      res.status(403).json({
        error:
          "Admin PIN isn't set up yet — set it in Settings, or add the ADMIN_PIN secret.",
      });
      return false;
    }
    const remaining = pinLockoutRemainingMs();
    if (remaining > 0) {
      sendLockout(res, remaining);
      return false;
    }
    if (!pin || !(await adminPinMatches(pin))) {
      const locked = registerPinFailure();
      req.log.warn(
        logMeta,
        locked
          ? `${action}: too many wrong PINs — locked out 15 min`
          : `${action} rejected: wrong PIN`,
      );
      res.status(403).json({ error: "Incorrect admin PIN" });
      return false;
    }
    resetPinLockout();
    return true;
  } catch (err) {
    req.log.error({ err, ...logMeta }, `${action}: PIN check failed`);
    res.status(500).json({ error: "PIN check failed" });
    return false;
  }
}

export { sendLockout };
