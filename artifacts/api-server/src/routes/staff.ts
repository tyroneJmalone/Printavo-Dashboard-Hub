import { Router, type IRouter } from "express";
import { db, staffUsersTable, type StaffUser } from "@workspace/db";
import { and, asc, eq, ne } from "drizzle-orm";
import {
  AddStaffBody,
  UpdateStaffRoleBody,
  SetAdminPinBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import {
  getAdminPinSource,
  adminPinMatches,
  setAdminPin,
  pinLockoutRemainingMs,
  registerPinFailure,
  resetPinLockout,
  sendLockout,
} from "../lib/auth/adminPin";

/**
 * Staff allowlist management + admin PIN rotation. Every route here is
 * admin-only — requireAdmin is applied PER ROUTE (not router.use) because
 * this router is mounted at the root and use() would gate sibling routers.
 *
 * Guards (server-side, the UI only mirrors them):
 * - You can't remove yourself.
 * - You can't demote or remove the last admin.
 */
const router: IRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_RE = /^\d{4,12}$/;

/** Postgres unique-violation (23505), possibly wrapped in a cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (typeof e === "object" && e !== null) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function toStaffMember(row: StaffUser) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    addedByEmail: row.addedByEmail,
    linked: row.clerkUserId != null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** True if at least one admin exists besides the given row id. */
async function otherAdminExists(excludeId: string): Promise<boolean> {
  const rows = await db
    .select({ id: staffUsersTable.id })
    .from(staffUsersTable)
    .where(and(eq(staffUsersTable.role, "admin"), ne(staffUsersTable.id, excludeId)))
    .limit(1);
  return rows.length > 0;
}

router.get("/auth/staff", requireAdmin, (req, res) => {
  db.select()
    .from(staffUsersTable)
    .orderBy(asc(staffUsersTable.createdAt))
    .then((rows) => res.json({ staff: rows.map(toStaffMember) }))
    .catch((err) => {
      req.log.error({ err }, "list staff failed");
      res.status(500).json({ error: "Failed to load staff list" });
    });
});

router.post("/auth/staff", requireAdmin, async (req, res) => {
  try {
    const parsed = AddStaffBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid staff payload" });
      return;
    }
    const email = parsed.data.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: "That doesn't look like a valid email address" });
      return;
    }
    const [existing] = await db
      .select({ id: staffUsersTable.id })
      .from(staffUsersTable)
      .where(eq(staffUsersTable.email, email))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `${email} is already on the staff list` });
      return;
    }
    const [created] = await db
      .insert(staffUsersTable)
      .values({
        email,
        role: parsed.data.role,
        addedByEmail: req.staff!.email,
      })
      .returning();
    req.log.info(
      { email, role: parsed.data.role, addedBy: req.staff!.email },
      "staff member added",
    );
    res.status(201).json(toStaffMember(created));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "That email is already on the staff list" });
      return;
    }
    req.log.error({ err }, "add staff failed");
    res.status(500).json({ error: "Failed to add staff member" });
  }
});

router.patch("/auth/staff/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const parsed = UpdateStaffRoleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid role payload" });
      return;
    }
    const [target] = await db
      .select()
      .from(staffUsersTable)
      .where(eq(staffUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Staff member not found" });
      return;
    }
    if (target.role === parsed.data.role) {
      res.json(toStaffMember(target));
      return;
    }
    if (
      target.role === "admin" &&
      parsed.data.role === "staff" &&
      !(await otherAdminExists(target.id))
    ) {
      res.status(409).json({
        error: "Can't demote the only admin — promote someone else first.",
      });
      return;
    }
    const [updated] = await db
      .update(staffUsersTable)
      .set({ role: parsed.data.role, updatedAt: new Date() })
      .where(eq(staffUsersTable.id, target.id))
      .returning();
    req.log.info(
      { email: target.email, from: target.role, to: parsed.data.role, by: req.staff!.email },
      "staff role changed",
    );
    res.json(toStaffMember(updated));
  } catch (err) {
    req.log.error({ err }, "update staff role failed");
    res.status(500).json({ error: "Failed to change role" });
  }
});

router.delete("/auth/staff/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const [target] = await db
      .select()
      .from(staffUsersTable)
      .where(eq(staffUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Staff member not found" });
      return;
    }
    if (target.id === req.staff!.id) {
      res.status(409).json({ error: "You can't remove yourself from the staff list." });
      return;
    }
    if (target.role === "admin" && !(await otherAdminExists(target.id))) {
      res.status(409).json({
        error: "Can't remove the only admin — promote someone else first.",
      });
      return;
    }
    await db.delete(staffUsersTable).where(eq(staffUsersTable.id, target.id));
    req.log.info(
      { email: target.email, role: target.role, by: req.staff!.email },
      "staff member removed",
    );
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "remove staff failed");
    res.status(500).json({ error: "Failed to remove staff member" });
  }
});

router.get("/auth/admin-pin", requireAdmin, (req, res) => {
  getAdminPinSource()
    .then((source) => res.json({ configured: source !== null, source }))
    .catch((err) => {
      req.log.error({ err }, "admin pin status failed");
      res.status(500).json({ error: "Failed to load PIN status" });
    });
});

router.put("/auth/admin-pin", requireAdmin, async (req, res) => {
  try {
    const parsed = SetAdminPinBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid PIN payload" });
      return;
    }
    const newPin = parsed.data.newPin.trim();
    if (!PIN_RE.test(newPin)) {
      res.status(400).json({ error: "PIN must be 4–12 digits" });
      return;
    }
    const source = await getAdminPinSource();
    if (source !== null) {
      // Rotating an existing PIN requires the current one, with the same
      // lockout as every other PIN check.
      const remaining = pinLockoutRemainingMs();
      if (remaining > 0) {
        sendLockout(res, remaining);
        return;
      }
      const current = parsed.data.currentPin ?? "";
      if (!current || !(await adminPinMatches(current))) {
        const locked = registerPinFailure();
        req.log.warn(
          { by: req.staff!.email },
          locked
            ? "change admin PIN: too many wrong PINs — locked out 15 min"
            : "change admin PIN rejected: wrong current PIN",
        );
        res.status(403).json({ error: "Current PIN is incorrect" });
        return;
      }
      resetPinLockout();
    }
    await setAdminPin(newPin);
    req.log.info({ by: req.staff!.email }, "admin PIN changed");
    res.json({ configured: true, source: "database" });
  } catch (err) {
    req.log.error({ err }, "set admin pin failed");
    res.status(500).json({ error: "Failed to change PIN" });
  }
});

export default router;
