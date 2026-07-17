import type { Logger } from "pino";
import { db, staffUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Idempotent startup seed: ensure at least one admin exists. Runs in BOTH
 * dev and prod (separate databases — a data migration wouldn't reach both).
 * If Tyler's row exists but was somehow demoted while no other admin
 * exists, it is promoted back — the app must never be left admin-less.
 */
const BOOTSTRAP_ADMIN_EMAIL = "tyler@mintprintworks.com";

export async function bootstrapStaffAdmin(logger: Logger): Promise<void> {
  const admins = await db
    .select({ id: staffUsersTable.id })
    .from(staffUsersTable)
    .where(eq(staffUsersTable.role, "admin"))
    .limit(1);
  if (admins.length > 0) return;

  const [existing] = await db
    .select()
    .from(staffUsersTable)
    .where(eq(staffUsersTable.email, BOOTSTRAP_ADMIN_EMAIL))
    .limit(1);

  if (existing) {
    await db
      .update(staffUsersTable)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(staffUsersTable.id, existing.id));
    logger.warn(
      { email: BOOTSTRAP_ADMIN_EMAIL },
      "no admin existed — promoted bootstrap admin",
    );
    return;
  }

  await db.insert(staffUsersTable).values({
    email: BOOTSTRAP_ADMIN_EMAIL,
    role: "admin",
    addedByEmail: null,
  });
  logger.info(
    { email: BOOTSTRAP_ADMIN_EMAIL },
    "seeded bootstrap admin into staff allowlist",
  );
}
