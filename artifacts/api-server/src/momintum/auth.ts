import type { NextFunction, Request, Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { sql, asc } from "drizzle-orm";
import { db, membersTable, type Member } from "@workspace/momintum-db";

/**
 * Auth adapter between the hub's staff allowlist and moMINTum's member model.
 *
 * The hub's `requireStaff` middleware runs upstream of every route in this
 * module, so `req.staff` is always set. Member identity in the shared LIVE
 * moMINTum database is resolved BY EMAIL ONLY (case-insensitive):
 *
 * - The hub and the standalone moMINTum app use DIFFERENT Clerk tenants, so
 *   `members.clerk_user_id` (which stores the standalone app's Clerk IDs)
 *   must NEVER be written from the hub — overwriting it would unlink users
 *   from the standalone app.
 * - `members.email` is not unique in that schema; we deterministically pick
 *   the oldest matching row (lowest id).
 * - If no member row exists for the staff email, we JIT-create one with a
 *   NULL clerk_user_id — the standalone app will link it on that person's
 *   first standalone sign-in, exactly like a pre-provisioned row.
 */

/** Belt-and-braces re-check; requireStaff is already mounted upstream. */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.staff) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/** Admin gate using moMINTum's own members.is_admin flag. */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.staff) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const member = await getOrCreateCurrentMember(req);
  if (!member?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

/**
 * Resolves the moMINTum member row for the current hub staff user by email,
 * JIT-creating a member (with NULL clerk_user_id) if none exists.
 */
export async function getOrCreateCurrentMember(
  req: Request,
): Promise<Member | undefined> {
  const email = req.staff?.email?.trim().toLowerCase();
  if (!email) return undefined;

  const [byEmail] = await db
    .select()
    .from(membersTable)
    .where(sql`lower(${membersTable.email}) = ${email}`)
    .orderBy(asc(membersTable.id))
    .limit(1);
  if (byEmail) return byEmail;

  // JIT-create. Best-effort name from the hub's Clerk profile; fall back to
  // the email local part.
  let name = email.split("@")[0] || email;
  try {
    const auth = getAuth(req);
    if (auth?.userId) {
      const clerkUser = await clerkClient.users.getUser(auth.userId);
      const fromClerk = [clerkUser.firstName, clerkUser.lastName]
        .filter(Boolean)
        .join(" ");
      if (fromClerk) name = fromClerk;
    }
  } catch {
    // Non-fatal — keep the email-derived fallback name.
  }

  const colors = ["#4ade80", "#9e4a95", "#2baeae", "#ec6b4d", "#546290"];
  const color = colors[Math.floor(Math.random() * colors.length)];

  // JIT-create under a transaction-scoped advisory lock keyed on the email.
  // members.email has no unique index (and must not gain one — the standalone
  // app owns that schema), so without the lock two concurrent first requests
  // both pass the SELECT above and insert duplicate rows.
  // NOTE: clerkUserId is intentionally NOT set here (see module docblock).
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"momintum:jit-member:" + email}))`,
    );
    const [existing] = await tx
      .select()
      .from(membersTable)
      .where(sql`lower(${membersTable.email}) = ${email}`)
      .orderBy(asc(membersTable.id))
      .limit(1);
    if (existing) return existing;

    const [created] = await tx
      .insert(membersTable)
      .values({ name, email, color })
      .returning();
    return created;
  });
}
