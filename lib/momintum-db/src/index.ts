import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

/**
 * Connection to the standalone moMINTum app's LIVE database (shared with the
 * deployed standalone app — both apps read/write the same data).
 *
 * HARD RULES for this package:
 * - NO drizzle.config, NO push script — the hub must NEVER run schema
 *   migrations against this database. Schema is owned by the standalone app.
 * - The pool is created lazily; the hub boots fine without the secret and the
 *   momintum routes simply stay unmounted (see isMomintumConfigured).
 * - Never write members.clerk_user_id from the hub — it stores the standalone
 *   app's Clerk tenant IDs; overwriting them would unlink standalone users.
 */

type MomintumDb = ReturnType<typeof drizzle<typeof schema>>;

let _db: MomintumDb | null = null;

export function isMomintumConfigured(): boolean {
  return !!process.env.MOMINTUM_DATABASE_URL;
}

export function momintumDb(): MomintumDb {
  if (!_db) {
    const url = process.env.MOMINTUM_DATABASE_URL;
    if (!url) {
      throw new Error(
        "MOMINTUM_DATABASE_URL is not set — moMINTum features are unavailable.",
      );
    }
    _db = drizzle(new Pool({ connectionString: url }), { schema });
  }
  return _db;
}

/**
 * Lazy proxy so route modules can `import { db }` verbatim (mirroring the
 * standalone app) without opening a connection at import time. The real
 * drizzle instance is created on first property access.
 */
export const db: MomintumDb = new Proxy({} as MomintumDb, {
  get(_target, prop) {
    const real = momintumDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export * from "./schema";
