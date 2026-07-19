import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

/**
 * Connection to the standalone Mint Bucks app's LIVE database (shared with the
 * deployed standalone app — both apps read/write the same data).
 *
 * HARD RULES for this package (see MINT_BUCKS_HANDOFF.md §12 in the source repo):
 * - NO drizzle.config, NO push script — the hub must NEVER run schema
 *   migrations against this database. Schema is owned by the standalone app
 *   (lib/db/src/schema + drizzle-kit push over there).
 * - The pool is created lazily; the hub boots fine without the secret and the
 *   mintbucks routes simply stay unmounted (see isMintbucksConfigured).
 * - Money columns are numeric → returned as STRINGS by pg. Never float-math
 *   dollar values; keep them as strings or use decimal-safe arithmetic.
 * - The two unique indexes (reward_awards rule+invoice, notification_log
 *   customer+order) are load-bearing dedup ledgers — never bypass them.
 */

type MintbucksDb = ReturnType<typeof drizzle<typeof schema>>;

let _db: MintbucksDb | null = null;
let _pool: pg.Pool | null = null;

export function isMintbucksConfigured(): boolean {
  return !!process.env.MINTBUCKS_DATABASE_URL;
}

export function mintbucksPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.MINTBUCKS_DATABASE_URL;
    if (!url) {
      throw new Error(
        "MINTBUCKS_DATABASE_URL is not set — Mint Bucks features are unavailable.",
      );
    }
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

export function mintbucksDb(): MintbucksDb {
  if (!_db) {
    _db = drizzle(mintbucksPool(), { schema });
  }
  return _db;
}

export * from "./schema";
