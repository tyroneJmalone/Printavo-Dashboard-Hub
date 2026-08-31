import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { db } from "@workspace/db";

/**
 * Single-writer rule for the email sync: once the sync scheduler runs 24/7
 * in production, the development workspace must not run a competing sync
 * against the same database (duplicate Missive/Gmail API traffic, racing
 * upserts).
 *
 * Mechanism: a lease row in app_settings claimed with a SINGLE atomic
 * conditional upsert — the WHERE clause on the conflict update decides
 * ownership under the row lock, so there is no read-then-write window in
 * which two schedulers can both conclude they own the lease:
 *
 * - The current owner renews its own lease.
 * - Production may always take the lease (there is exactly one production
 *   instance — a Reserved VM — by design).
 * - Anyone may take an expired lease (no heartbeat for 30+ minutes).
 *
 * A tick only syncs when the statement actually updated/inserted the row.
 * Development sync therefore keeps working until the Hub is published, then
 * automatically stands down; if production stops for 30+ minutes, dev picks
 * the role back up. No flags to remember.
 */

const WRITER_KEY = "email_sync_writer";
const LEASE_FRESH_SECONDS = 30 * 60;

export function emailSyncEnvironment(): "production" | "development" {
  return process.env.REPLIT_DEPLOYMENT ? "production" : "development";
}

let lastDecision: boolean | null = null;

export async function claimEmailSyncWriter(log: Logger): Promise<boolean> {
  const claimed = await claimEmailSyncWriterAs(emailSyncEnvironment());
  if (claimed !== lastDecision) {
    if (claimed) {
      log.info({ env: emailSyncEnvironment() }, "email sync: claiming writer role");
    } else {
      log.info(
        "email sync: another environment holds the writer lease — this sync is standing down",
      );
    }
  }
  lastDecision = claimed;
  return claimed;
}

/**
 * Atomic lease claim, separated from the env detection so it is testable.
 * Returns true only when this statement inserted or updated the lease row —
 * i.e. we verifiably own the lease for this tick.
 */
export async function claimEmailSyncWriterAs(
  env: "production" | "development",
): Promise<boolean> {
  const value = JSON.stringify({ environment: env, at: new Date().toISOString() });
  const result = await db.execute(sql`
    insert into app_settings (key, value, updated_at)
    values (${WRITER_KEY}, ${value}::jsonb, now())
    on conflict (key) do update
      set value = excluded.value, updated_at = now()
      where app_settings.value->>'environment' = ${env}
        or ${env} = 'production'
        or coalesce(
             (app_settings.value->>'at')::timestamptz,
             'epoch'::timestamptz
           ) < now() - make_interval(secs => ${LEASE_FRESH_SECONDS})
    returning app_settings.value->>'environment' as owner
  `);
  return result.rows.length > 0;
}

/** Test/ops helper: drop the lease so the next tick re-elects a writer. */
export async function releaseEmailSyncWriter(): Promise<void> {
  await db.execute(sql`delete from app_settings where key = ${WRITER_KEY}`);
}
