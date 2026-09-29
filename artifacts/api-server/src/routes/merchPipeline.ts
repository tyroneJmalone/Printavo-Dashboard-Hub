import { Router, type Request, type Response, type NextFunction } from "express";
import { db, pool, merchOpportunitiesTable as opportunities, merchThreadLinksTable as links, staffUsersTable, chipplyStoresTable } from "@workspace/db";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { opportunitySchema, threadLinkSchema, missiveConversationId } from "../lib/merchPipeline/validation";
import { canReadThread, requireThreadRead } from "../lib/emailAccess/authorization";
import { authorizedThreads } from "./correspondence";

const router = Router();
const uuid = z.string().uuid();
// Opportunities are shared team records behind the pipeline module gate, not owner-private
// records. Owner is assignment only. Correspondence keeps its separate per-user ACL.
async function knownManualThread(manualUrl: string) {
  const providerId = missiveConversationId(manualUrl);
  if (!providerId) throw Object.assign(new Error("Not found"), { status: 404 });
  const result = await pool.query(
    `SELECT id FROM correspondence_threads WHERE (provider='missive' AND lower(provider_thread_id)=$1) OR web_url=$2 ORDER BY id LIMIT 1`,
    [providerId, manualUrl],
  );
  return result.rows[0]?.id as string | undefined;
}
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(error => {
    if (error instanceof z.ZodError) return void res.status(400).json({ error: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (error.status === 404) return void res.status(404).json({ error: "Not found" });
    next(error);
  });
};
router.get("/merch-pipeline/staff", wrap(async (_req, res) => {
  // The existing /auth/staff management endpoint is admin-only; never expose its full rows.
  res.json(await db.select({ id: staffUsersTable.id, email: staffUsersTable.email }).from(staffUsersTable).orderBy(asc(staffUsersTable.email)));
}));
router.get("/merch-pipeline/stores", wrap(async (req, res) => {
  const q = z.string().max(300).parse(req.query.q ?? "");
  const result = await pool.query(`SELECT id, store_name AS name, event_id AS "eventId" FROM chipply_stores WHERE store_name ILIKE $1 OR event_id ILIKE $1 ORDER BY store_name LIMIT 100`, [`%${q.replace(/[%_\\]/g, "\\$&")}%`]);
  res.json(result.rows);
}));
router.get("/merch-pipeline/opportunities", wrap(async (_req, res) => {
  res.json(await db.select().from(opportunities).orderBy(desc(opportunities.updatedAt)));
}));
async function validateReferences(data: z.infer<typeof opportunitySchema>) {
  if (data.ownerId && !(await db.select({ id: staffUsersTable.id }).from(staffUsersTable).where(eq(staffUsersTable.id, data.ownerId))).length) throw Object.assign(new Error("Owner not found"), { status: 404 });
  if (data.chipplyStoreId && !(await db.select({ id: chipplyStoresTable.id }).from(chipplyStoresTable).where(eq(chipplyStoresTable.id, data.chipplyStoreId))).length) throw Object.assign(new Error("Store not found"), { status: 404 });
  const { launchDate, closeDate, inHandDate } = data.details;
  if ((launchDate && closeDate && launchDate > closeDate) || (closeDate && inHandDate && closeDate > inHandDate)) {
    throw new z.ZodError([{ code: "custom", path: ["details"], message: "Dates must be ordered launch, close, in-hand" }]);
  }
}
router.post("/merch-pipeline/opportunities", wrap(async (req, res) => {
  const data = opportunitySchema.parse(req.body);
  await validateReferences(data);
  res.status(201).json((await db.insert(opportunities).values(data).returning())[0]);
}));
router.patch("/merch-pipeline/opportunities/:id", wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const [existing] = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (!existing) return void res.status(404).json({ error: "Not found" });
  const patch = opportunitySchema.partial().parse(req.body);
  // Zod defaults must not turn an archive/stage-only PATCH into a field reset.
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    if (!Object.prototype.hasOwnProperty.call(req.body, key)) delete patch[key];
  }
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...editable } = existing;
  const data = opportunitySchema.parse({ ...editable, ...patch, details: { ...(existing.details as object), ...patch.details } });
  await validateReferences(data);
  res.json((await db.update(opportunities).set({ ...data, updatedAt: new Date() }).where(eq(opportunities.id, id)).returning())[0]);
}));
router.delete("/merch-pipeline/opportunities/:id", wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  z.object({ confirmed: z.literal(true) }).parse(req.body);
  const result = await pool.query(`DELETE FROM merch_opportunities o WHERE id=$1 AND archived=true AND chipply_store_id IS NULL AND event_id IS NULL AND NOT EXISTS (SELECT 1 FROM merch_thread_links l WHERE l.opportunity_id=o.id) RETURNING id`, [id]);
  if (!result.rowCount) return void res.status(409).json({ error: "Archive and unlink the store, event, and correspondence before permanently deleting." });
  res.status(204).end();
}));

for (const kind of ["opportunity", "store"] as const) {
  const base = kind === "opportunity" ? "/merch-pipeline/opportunities/:id/threads" : "/chipply/stores/:id/threads";
  const column = kind === "opportunity" ? links.opportunityId : links.storeId;
  // Preserve the original link identity when a prelaunch opportunity gains a store.
  // Both detail surfaces show the same authorized correspondence without copying links.
  const scope = (id: string) => kind === "store"
    ? sql`(${links.storeId} = ${id}::uuid OR ${links.opportunityId} IN (SELECT id FROM merch_opportunities WHERE chipply_store_id = ${id}::uuid))`
    : sql`(${links.opportunityId} = ${id}::uuid OR ${links.storeId} = (SELECT chipply_store_id FROM merch_opportunities WHERE id = ${id}::uuid))`;
  async function parent(req: Request) {
    const id = uuid.parse(req.params.id);
    const result = await pool.query(`SELECT id FROM ${kind === "opportunity" ? "merch_opportunities" : "chipply_stores"} WHERE id=$1`, [id]);
    if (!result.rowCount) throw Object.assign(new Error("Not found"), { status: 404 });
    return id;
  }
  router.get(base, wrap(async (req, res) => {
    const id = await parent(req);
    if (req.query.search !== undefined) {
      const term = z.string().trim().min(2).max(300).parse(req.query.search);
      const result = await authorizedThreads(req.staff!.id, req.staff!.role === "admin", term, 30, 0);
      return void res.json({ suggestions: result.threads });
    }
    const rows = await db.select().from(links).where(scope(id));
    const visible = [];
    for (const row of rows) {
      if (row.threadId) {
        if (!(await canReadThread(req.staff!, row.threadId))) continue;
        const result = await pool.query("SELECT subject, web_url FROM correspondence_threads WHERE id=$1", [row.threadId]);
        visible.push({ id: row.id, threadId: row.threadId, subject: result.rows[0]?.subject, url: result.rows[0]?.web_url });
      } else {
        // A manual link can become an ingested conversation later. Recheck on every
        // read instead of retaining a permanent URL-only bypass of a revoked ACL.
        if (!row.manualUrl || !missiveConversationId(row.manualUrl)) continue;
        const knownId = await knownManualThread(row.manualUrl);
        if (knownId && !(await canReadThread(req.staff!, knownId))) continue;
        visible.push({ id: row.id, threadId: null, subject: "Manually linked Missive conversation", url: row.manualUrl });
      }
    }
    res.json({ links: visible });
  }));
  router.post(base, wrap(async (req, res) => {
    const id = await parent(req);
    const input = threadLinkSchema.parse(req.body);
    if (input.manualUrl) {
      const knownId = await knownManualThread(input.manualUrl);
      if (knownId) {
        await requireThreadRead(req.staff!, knownId);
        input.threadId = knownId;
        input.manualUrl = undefined;
      }
    }
    if (input.threadId) await requireThreadRead(req.staff!, input.threadId);
    const values = { opportunityId: kind === "opportunity" ? id : null, storeId: kind === "store" ? id : null, threadId: input.threadId ?? null, manualUrl: input.manualUrl ?? null, createdBy: req.staff!.id };
    // Serialize per entity to make repeated confirmation idempotent.
    const created = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${kind}:${id}`}))`);
      const existing = await tx.select().from(links).where(and(eq(column, id), input.threadId ? eq(links.threadId, input.threadId) : eq(links.manualUrl, input.manualUrl!)));
      return existing[0] ?? (await tx.insert(links).values(values).returning())[0];
    });
    res.status(201).json({ id: created.id });
  }));
  router.delete(`${base}/:linkId`, wrap(async (req, res) => {
    const id = await parent(req);
    const linkId = uuid.parse(req.params.linkId);
    z.object({ confirmed: z.literal(true) }).parse(req.body);
    const [link] = await db.select().from(links).where(and(scope(id), eq(links.id, linkId)));
    if (!link) return void res.status(404).json({ error: "Not found" });
    if (link.threadId) await requireThreadRead(req.staff!, link.threadId);
    else if (link.manualUrl) {
      const knownId = await knownManualThread(link.manualUrl);
      if (knownId) await requireThreadRead(req.staff!, knownId);
    }
    await db.delete(links).where(eq(links.id, linkId));
    res.status(204).end();
  }));
}
export default router;