import { Router } from "express";
import {
  db,
  emailAccessGroupMailboxesTable,
  emailAccessGroupMembersTable,
  emailAccessGroupsTable,
  emailAccessSettingsTable,
  emailMailboxPoliciesTable,
  emailMailboxesTable,
  staffUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireCapability } from "../middlewares/requireStaff";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const text = (value: unknown, max = 500) =>
  typeof value === "string" && value.trim().length <= max ? value.trim() : null;

router.use("/email-access", requireCapability("manage_email_access"));

router.get("/email-access/groups", async (_req, res) => {
  const groups = await db.select().from(emailAccessGroupsTable);
  const members = await db.select().from(emailAccessGroupMembersTable);
  const mailboxes = await db.select().from(emailAccessGroupMailboxesTable);
  const staff = await db.select({ id: staffUsersTable.id, email: staffUsersTable.email }).from(staffUsersTable);
  const mailboxRows = await db.select({ id: emailMailboxesTable.id, email: emailMailboxesTable.email }).from(emailMailboxesTable);
  res.json({ groups: groups.map((group) => ({
    ...group,
    members: members.filter((x) => x.groupId === group.id).map((x) => staff.find((s) => s.id === x.staffId)?.email ?? x.staffId),
    mailboxes: mailboxes.filter((x) => x.groupId === group.id).map((x) => mailboxRows.find((b) => b.id === x.mailboxId)?.email ?? x.mailboxId),
  })) });
});

router.post("/email-access/groups", async (req, res) => {
  const name = text(req.body?.name, 120);
  const description = text(req.body?.description ?? "", 2_000);
  if (!name || description === null) return void res.status(400).json({ error: "Valid group name and description are required" });
  try {
    const [group] = await db.insert(emailAccessGroupsTable).values({
      name, description, createdByEmail: req.staff!.email,
    }).returning();
    res.status(201).json(group);
  } catch {
    res.status(409).json({ error: "A group with that name already exists" });
  }
});

router.patch("/email-access/groups/:id", async (req, res) => {
  if (!validId(req.params.id)) return void res.status(404).json({ error: "Group not found" });
  const [existing] = await db.select().from(emailAccessGroupsTable).where(eq(emailAccessGroupsTable.id, req.params.id)).limit(1);
  if (!existing) return void res.status(404).json({ error: "Group not found" });
  const name = text(req.body?.name ?? existing.name, 120);
  const description = text(req.body?.description ?? existing.description, 2_000);
  if (!name || description === null) return void res.status(400).json({ error: "Valid group name and description are required" });
  if (req.body?.members !== undefined && (!Array.isArray(req.body.members) || !req.body.members.every((x: unknown) => typeof x === "string"))) return void res.status(400).json({ error: "Members must be email addresses" });
  if (req.body?.mailboxes !== undefined && (!Array.isArray(req.body.mailboxes) || !req.body.mailboxes.every((x: unknown) => typeof x === "string"))) return void res.status(400).json({ error: "Mailboxes must be email addresses" });
  const memberEmails = req.body?.members ? [...new Set(req.body.members.map((x: string) => x.trim().toLowerCase()))] : null;
  const mailboxEmails = req.body?.mailboxes ? [...new Set(req.body.mailboxes.map((x: string) => x.trim().toLowerCase()))] : null;
  const members = memberEmails ? await db.select({ id: staffUsersTable.id, email: staffUsersTable.email }).from(staffUsersTable) : [];
  const mailboxes = mailboxEmails ? await db.select({ id: emailMailboxesTable.id, email: emailMailboxesTable.email }).from(emailMailboxesTable) : [];
  if ((memberEmails && (members.length !== memberEmails.length || members.some((x) => !memberEmails.includes(x.email)))) || (mailboxEmails && (mailboxes.length !== mailboxEmails.length || mailboxes.some((x) => !mailboxEmails.includes(x.email))))) return void res.status(400).json({ error: "Unknown group member or mailbox" });
  const group = await db.transaction(async (tx) => {
    const [updated] = await tx.update(emailAccessGroupsTable).set({ name, description, updatedAt: new Date() }).where(eq(emailAccessGroupsTable.id, req.params.id)).returning();
    if (memberEmails) {
      await tx.delete(emailAccessGroupMembersTable).where(eq(emailAccessGroupMembersTable.groupId, req.params.id));
      if (members.length) await tx.insert(emailAccessGroupMembersTable).values(members.map((x) => ({ groupId: req.params.id as string, staffId: x.id })));
    }
    if (mailboxEmails) {
      await tx.delete(emailAccessGroupMailboxesTable).where(eq(emailAccessGroupMailboxesTable.groupId, req.params.id));
      if (mailboxes.length) await tx.insert(emailAccessGroupMailboxesTable).values(mailboxes.map((x) => ({ groupId: req.params.id as string, mailboxId: x.id })));
    }
    return updated;
  });
  res.json(group);
});

router.delete("/email-access/groups/:id", async (req, res) => {
  if (!validId(req.params.id)) return void res.status(404).json({ error: "Group not found" });
  const [group] = await db.delete(emailAccessGroupsTable).where(eq(emailAccessGroupsTable.id, req.params.id)).returning();
  if (!group) return void res.status(404).json({ error: "Group not found" });
  res.status(204).end();
});

router.put("/email-access/groups/:id/members", async (req, res) => {
  if (!validId(req.params.id) || !Array.isArray(req.body?.staffIds) || !req.body.staffIds.every(validId)) {
    return void res.status(400).json({ error: "Valid staffIds are required" });
  }
  const staffIds = [...new Set(req.body.staffIds as string[])];
  const group = await db.select({ id: emailAccessGroupsTable.id }).from(emailAccessGroupsTable).where(eq(emailAccessGroupsTable.id, req.params.id)).limit(1);
  if (!group[0]) return void res.status(404).json({ error: "Group not found" });
  const staff = staffIds.length ? await db.select({ id: staffUsersTable.id }).from(staffUsersTable) : [];
  if (staff.length !== staffIds.length || staff.some((x) => !staffIds.includes(x.id))) return void res.status(400).json({ error: "Unknown staff member" });
  await db.transaction(async (tx) => {
    await tx.delete(emailAccessGroupMembersTable).where(eq(emailAccessGroupMembersTable.groupId, req.params.id));
    if (staffIds.length) await tx.insert(emailAccessGroupMembersTable).values(staffIds.map((staffId) => ({ groupId: req.params.id, staffId })));
  });
  res.status(204).end();
});

router.put("/email-access/groups/:id/mailboxes", async (req, res) => {
  if (!validId(req.params.id) || !Array.isArray(req.body?.mailboxIds) || !req.body.mailboxIds.every(validId)) return void res.status(400).json({ error: "Valid mailboxIds are required" });
  const group = await db.select({ id: emailAccessGroupsTable.id }).from(emailAccessGroupsTable).where(eq(emailAccessGroupsTable.id, req.params.id)).limit(1);
  if (!group[0]) return void res.status(404).json({ error: "Group not found" });
  const ids = [...new Set(req.body.mailboxIds as string[])];
  const boxes = ids.length ? await db.select({ id: emailMailboxesTable.id }).from(emailMailboxesTable) : [];
  if (boxes.length !== ids.length) return void res.status(400).json({ error: "Unknown mailbox" });
  await db.transaction(async (tx) => {
    await tx.delete(emailAccessGroupMailboxesTable).where(eq(emailAccessGroupMailboxesTable.groupId, req.params.id));
    if (ids.length) await tx.insert(emailAccessGroupMailboxesTable).values(ids.map((mailboxId) => ({ groupId: req.params.id, mailboxId })));
  });
  res.status(204).end();
});

router.get("/email-access/mailboxes", async (_req, res) => {
  const mailboxes = await db.select().from(emailMailboxesTable);
  const policies = await db.select().from(emailMailboxPoliciesTable);
  const staff = await db
    .select({ id: staffUsersTable.id, email: staffUsersTable.email, role: staffUsersTable.role })
    .from(staffUsersTable);
  res.json({
    mailboxes: mailboxes.map((mailbox) => ({
      id: mailbox.id,
      email: mailbox.email,
      displayName: mailbox.displayName,
      policy: policies.find((p) => p.mailboxId === mailbox.id) ?? null,
    })),
    staff,
  });
});

router.get("/email-access/policy", async (_req, res) => {
  await db.insert(emailAccessSettingsTable).values({ id: 1 }).onConflictDoNothing();
  const [settings] = await db.select().from(emailAccessSettingsTable).where(eq(emailAccessSettingsTable.id, 1));
  res.json(settings);
});

router.put("/email-access/policy", async (req, res) => {
  const current = (await db.select().from(emailAccessSettingsTable).where(eq(emailAccessSettingsTable.id, 1)))[0];
  const defaultAccess = req.body?.defaultAccess ?? current?.defaultAccess ?? "deny";
  const retentionDays = req.body?.retentionDays ?? current?.retentionDays ?? 3650;
  const aiProcessingEnabled = req.body?.aiProcessingEnabled ?? current?.aiProcessingEnabled ?? true;
  if (defaultAccess !== "deny" || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 36_500 || typeof aiProcessingEnabled !== "boolean") return void res.status(400).json({ error: "Invalid access policy" });
  const [settings] = await db.insert(emailAccessSettingsTable).values({ id: 1, defaultAccess, retentionDays, aiProcessingEnabled, updatedByEmail: req.staff!.email, updatedAt: new Date() })
    .onConflictDoUpdate({ target: emailAccessSettingsTable.id, set: { defaultAccess, retentionDays, aiProcessingEnabled, updatedByEmail: req.staff!.email, updatedAt: new Date() } }).returning();
  res.json(settings);
});

router.put("/email-access/mailboxes/:id/policy", async (req, res) => {
  if (!validId(req.params.id)) return void res.status(404).json({ error: "Mailbox not found" });
  const { ownerStaffId = null, protected: protectedMailbox, visibility } = req.body ?? {};
  if ((ownerStaffId !== null && !validId(ownerStaffId)) || typeof protectedMailbox !== "boolean" || !["private", "group", "workspace"].includes(visibility)) return void res.status(400).json({ error: "Invalid mailbox policy" });
  const [mailbox] = await db.select({ id: emailMailboxesTable.id }).from(emailMailboxesTable).where(eq(emailMailboxesTable.id, req.params.id)).limit(1);
  if (!mailbox) return void res.status(404).json({ error: "Mailbox not found" });
  if (ownerStaffId) {
    const [owner] = await db.select({ id: staffUsersTable.id }).from(staffUsersTable).where(eq(staffUsersTable.id, ownerStaffId)).limit(1);
    if (!owner) return void res.status(400).json({ error: "Unknown mailbox owner" });
  }
  const [policy] = await db.insert(emailMailboxPoliciesTable).values({ mailboxId: req.params.id, ownerStaffId, protected: protectedMailbox, visibility, updatedByEmail: req.staff!.email, updatedAt: new Date() })
    .onConflictDoUpdate({ target: emailMailboxPoliciesTable.mailboxId, set: { ownerStaffId, protected: protectedMailbox, visibility, updatedByEmail: req.staff!.email, updatedAt: new Date() } }).returning();
  res.json(policy);
});

export default router;