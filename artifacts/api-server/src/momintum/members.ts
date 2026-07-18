import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, membersTable } from "@workspace/momintum-db";
import {
  CreateMemberBody,
  UpdateMemberParams,
  UpdateMemberBody,
  DeleteMemberParams,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin, getOrCreateCurrentMember } from "./auth";

const router: IRouter = Router();

router.get("/members", async (_req, res): Promise<void> => {
  const members = await db
    .select()
    .from(membersTable)
    .orderBy(membersTable.createdAt);
  res.json(members);
});

router.get("/members/me", requireAuth, async (req, res): Promise<void> => {
  const member = await getOrCreateCurrentMember(req);
  if (!member) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(member);
});

router.post("/members", async (req, res): Promise<void> => {
  const parsed = CreateMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [member] = await db
    .insert(membersTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(member);
});

router.patch("/members/:id", async (req, res): Promise<void> => {
  const params = UpdateMemberParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [member] = await db
    .update(membersTable)
    .set(parsed.data)
    .where(eq(membersTable.id, params.data.id))
    .returning();

  if (!member) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  res.json(member);
});

router.delete("/members/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteMemberParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const currentMember = await getOrCreateCurrentMember(req);
  if (currentMember?.id === params.data.id) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }

  const [deleted] = await db
    .delete(membersTable)
    .where(eq(membersTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  res.status(204).send();
});

// NOTE: POST /members/invite is intentionally NOT ported to the hub — invite
// emails are sent by the standalone moMINTum app (Resend connector lives
// there). The hub UI notes this instead of offering the button.

export default router;
