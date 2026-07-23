import type { Logger } from "pino";
import { pool } from "@workspace/db";

/**
 * Idempotent startup seed of Tyler's initial niche categories (Client 360).
 * Runs in BOTH dev and prod at boot (separate databases). ON CONFLICT keeps
 * renames/deactivations made in the UI — a seeded name that was renamed will
 * be re-inserted only if the new name no longer matches; deactivated rows
 * are left untouched because the conflict target is the unique name index.
 */
const SEED_CATEGORIES = [
  "Contractors & Trades",
  "Dance, Yoga, Etc Studio",
  "Entertainment",
  "Events & Hospitality",
  "Fitness, Training & Gyms",
  "Food Service",
  "Health & Wellness",
  "Manufacturing & Logistics",
  "Medical",
  "Non-Profit",
  "Professional Services",
  "Recreational Activities",
  "Salons, Barbershops & Aesthetics",
  "School & Education",
  "Sports Team Organization",
  "Tech",
  "Theater & The Arts",
];

export async function seedCustomerCategories(logger: Logger): Promise<void> {
  const existing = await pool.query(
    `SELECT count(*)::int AS n FROM customer_categories`,
  );
  if ((existing.rows[0]?.n ?? 0) > 0) return; // one-time seed only

  const values = SEED_CATEGORIES.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
  const params = SEED_CATEGORIES.flatMap((name, i) => [name, (i + 1) * 10]);
  await pool.query(
    `INSERT INTO customer_categories (name, sort_order) VALUES ${values} ON CONFLICT (name) DO NOTHING`,
    params,
  );
  logger.info({ count: SEED_CATEGORIES.length }, "seeded customer categories");
}
