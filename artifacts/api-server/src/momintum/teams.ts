import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, teamsTable, teamMembersTable } from "@workspace/momintum-db";
import { requireAdmin } from "./auth";
import {
  CreateTeamBody,
  UpdateTeamParams,
  UpdateTeamBody,
  DeleteTeamParams,
  AddTeamMemberParams,
  RemoveTeamMemberParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /teams — list all teams with their member ids
router.get("/teams", async (_req, res): Promise<void> => {
  const teams = await db.select().from(teamsTable).orderBy(teamsTable.createdAt);
  const memberships = await db.select().from(teamMembersTable);

  const result = teams.map((team) => ({
    ...team,
    memberIds: memberships
      .filter((m) => m.teamId === team.id)
      .map((m) => m.memberId),
  }));

  res.json(result);
});

// POST /teams — create a team (admin only)
router.post("/teams", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateTeamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [team] = await db
    .insert(teamsTable)
    .values({ name: parsed.data.name, color: parsed.data.color ?? "#2FADA8" })
    .returning();

  res.status(201).json({ ...team, memberIds: [] });
});

// PATCH /teams/:id — update team name/color (admin only)
router.patch("/teams/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateTeamParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateTeamBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [team] = await db
    .update(teamsTable)
    .set(parsed.data)
    .where(eq(teamsTable.id, params.data.id))
    .returning();

  if (!team) { res.status(404).json({ error: "Team not found" }); return; }

  const memberships = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.teamId, team.id));

  res.json({ ...team, memberIds: memberships.map((m) => m.memberId) });
});

// DELETE /teams/:id (admin only)
router.delete("/teams/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteTeamParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(teamsTable).where(eq(teamsTable.id, params.data.id));
  res.status(204).send();
});

// POST /teams/:id/members/:memberId — add member to team (admin only)
router.post("/teams/:id/members/:memberId", requireAdmin, async (req, res): Promise<void> => {
  const params = AddTeamMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }

  await db
    .insert(teamMembersTable)
    .values({ teamId: params.data.id, memberId: params.data.memberId })
    .onConflictDoNothing();

  const memberships = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.teamId, params.data.id));

  res.status(201).json({ teamId: params.data.id, memberIds: memberships.map((m) => m.memberId) });
});

// DELETE /teams/:id/members/:memberId — remove member from team (admin only)
router.delete("/teams/:id/members/:memberId", requireAdmin, async (req, res): Promise<void> => {
  const params = RemoveTeamMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }

  await db
    .delete(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.teamId, params.data.id),
        eq(teamMembersTable.memberId, params.data.memberId),
      ),
    );

  res.status(204).send();
});

export default router;
