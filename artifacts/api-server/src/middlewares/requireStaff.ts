import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, staffUsersTable, type StaffUser } from "@workspace/db";
import { eq } from "drizzle-orm";

export type StaffCapability =
  | "manage_staff"
  | "manage_email_configuration"
  | "manage_email_access"
  | "view_email_activity";

const ROLE_CAPABILITIES: Record<string, readonly StaffCapability[]> = {
  staff: [],
  manager: ["view_email_activity"],
  admin: [
    "manage_staff",
    "manage_email_configuration",
    "manage_email_access",
    "view_email_activity",
  ],
};

export function capabilitiesForRole(role: string): StaffCapability[] {
  return [...(ROLE_CAPABILITIES[role] ?? [])];
}

export function hasStaffCapability(
  staff: StaffUser | undefined,
  capability: StaffCapability,
): boolean {
  return Boolean(staff && capabilitiesForRole(staff.role).includes(capability));
}

export function requireCapability(capability: StaffCapability) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasStaffCapability(req.staff, capability)) {
      res.status(403).json({ error: "Permission denied", code: "missing_capability" });
      return;
    }
    next();
  };
}

declare global {
  namespace Express {
    interface Request {
      staff?: StaffUser;
    }
  }
}

/**
 * Staff allowlist gate for every non-public API route.
 *
 * Resolution order (per request — one indexed DB query in the common case;
 * removal from the allowlist takes effect immediately):
 *   1. No Clerk session → 401.
 *   2. staff_users row with this clerk_user_id → attach, done.
 *   3. First login in this environment: fetch the user's email from Clerk
 *      (one-time per user), match the lowercased email against the
 *      allowlist, link clerk_user_id to the row.
 *   4. No allowlist row → 403 { code: "not_allowlisted" } — signed in but
 *      not invited. The frontend shows a "not authorized" screen.
 */
export async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = getAuth(req);
    const clerkUserId = auth?.userId;
    if (!clerkUserId) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }

    const [linked] = await db
      .select()
      .from(staffUsersTable)
      .where(eq(staffUsersTable.clerkUserId, clerkUserId))
      .limit(1);
    if (linked) {
      req.staff = linked;
      next();
      return;
    }

    // First authenticated request in this environment — link by email.
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const emails = new Set(
      clerkUser.emailAddresses
        .map((e) => e.emailAddress.trim().toLowerCase())
        .filter(Boolean),
    );

    let matched: StaffUser | undefined;
    for (const email of emails) {
      const [row] = await db
        .select()
        .from(staffUsersTable)
        .where(eq(staffUsersTable.email, email))
        .limit(1);
      if (row) {
        matched = row;
        break;
      }
    }

    if (!matched) {
      res.status(403).json({
        error: "This account isn't on the staff list.",
        code: "not_allowlisted",
      });
      return;
    }

    const [updated] = await db
      .update(staffUsersTable)
      .set({ clerkUserId, updatedAt: new Date() })
      .where(eq(staffUsersTable.id, matched.id))
      .returning();
    req.staff = updated ?? matched;
    req.log.info(
      { staffEmail: matched.email, role: matched.role },
      "staff account linked to Clerk user",
    );
    next();
  } catch (err) {
    req.log.error({ err }, "staff auth check failed");
    res.status(500).json({ error: "Auth check failed" });
  }
}

/** Admin-only gate — mount AFTER requireStaff on individual routes. */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!hasStaffCapability(req.staff, "manage_staff")) {
    res.status(403).json({ error: "Admin access required", code: "not_admin" });
    return;
  }
  next();
}
