import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import router from "../src/routes/merchPipeline";
import { stages, missiveUrl, opportunitySchema } from "../src/lib/merchPipeline/validation";

// Invoke actual Express handlers, actual authorization helpers, and actual search SQL.
// Only persistence and external SDK initialization are replaced. No server or network.
const ids = Array.from({ length: 12 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const [oppId, storeId, otherStore, threadId, secretId, linkId, secretLink, staffId, unknownId, providerId, otherOpp] = ids;
let rows: Record<string, any[]>;
let threads: any[];
let acl: Record<string, { mailbox?: "owner" | "workspace" | "group"; protected?: boolean; grant?: string[]; revoked?: boolean; expired?: boolean }>;
let sqlCalls: string[];
let mutations: string[];
let checkedReads = new Set<string>();
const staff = { id: staffId, email: "staff@example.test", role: "staff" };
const dialect = new PgDialect();
function compile(where: any) { return dialect.sqlToQuery(where); }
function allowed(id: string, search = false, role = "staff") {
  if (!threads.some(t => t.id === id)) return false;
  if (role === "admin") return true;
  const a = acl[id] ?? {};
  return a.mailbox === "owner" || a.mailbox === "group" || (a.mailbox === "workspace" && !a.protected && role === "staff")
    || (!a.revoked && !a.expired && a.grant?.includes("read") && (!search || a.grant.includes("search")));
}
function filter(table: string, where: any) {
  const { sql, params } = compile(where);
  if (table !== "merch_thread_links") return rows[table].filter(r => r.id === params[0]);
  let selected = rows[table];
  if (sql.includes("SELECT id FROM merch_opportunities")) {
    selected = selected.filter(r => r.storeId === params[0] || rows.merch_opportunities.some(o => o.id === r.opportunityId && o.chipplyStoreId === params[0]));
  } else if (sql.includes("SELECT chipply_store_id")) {
    selected = selected.filter(r => r.opportunityId === params[0] || (r.storeId != null && rows.merch_opportunities.some(o => o.id === params[0] && o.chipplyStoreId === r.storeId)));
  } else {
    const field = sql.includes('"opportunity_id"') ? "opportunityId" : "storeId";
    selected = selected.filter(r => r[field] === params[0]);
    if (sql.includes('"thread_id"')) selected = selected.filter(r => r.threadId === params[1]);
    if (sql.includes('"manual_url"')) selected = selected.filter(r => r.manualUrl === params[1]);
  }
  if (sql.includes('"merch_thread_links"."id"')) selected = selected.filter(r => r.id === params.at(-1));
  return selected;
}
const fakeDb: any = {
  select: () => ({ from: (table: any) => ({
    where: async (where: any) => filter(getTableName(table), where),
    orderBy: async () => rows[getTableName(table)],
  }) }),
  insert: (table: any) => ({ values: (values: any) => ({ returning: async () => {
    const name = getTableName(table);
    mutations.push(`insert:${name}`);
    const row = { id: unknownId, createdAt: new Date(), updatedAt: new Date(), ...values };
    rows[name].push(row); return [row];
  } }) }),
  update: (table: any) => ({ set: (values: any) => ({ where: (where: any) => ({ returning: async () => {
    const name = getTableName(table);
    mutations.push(`update:${name}`);
    return filter(name, where).map(r => Object.assign(r, values));
  } }) }) }),
  delete: (table: any) => ({ where: async (where: any) => {
    const name = getTableName(table);
    const { params } = compile(where);
    mutations.push(`delete:${name}`);
    rows[name] = rows[name].filter(r => r.id !== params[0]);
  } }),
  transaction: async (fn: any) => fn(fakeDb),
  execute: async () => undefined,
};
beforeEach(() => {
  const opportunity = { ...opportunitySchema.parse({ name: "Prelaunch", ownerId: staffId, nextAction: "Call team", details: { notes: "Keep notes" } }), id: oppId, createdAt: new Date(), updatedAt: new Date() };
  rows = {
    merch_opportunities: [opportunity, { ...opportunity, id: otherOpp, name: "Unrelated" }],
    chipply_stores: [{ id: storeId }, { id: otherStore }],
    staff_users: [{ id: staffId }],
    merch_thread_links: [{ id: linkId, opportunityId: oppId, storeId: null, threadId, manualUrl: null }, { id: secretLink, opportunityId: oppId, storeId: null, threadId: secretId, manualUrl: null }],
  };
  threads = [
    { id: threadId, provider_thread_id: providerId, subject: "Visible conversation", web_url: `https://mail.missiveapp.com/#inbox/${providerId}`, last_message_at: new Date(), total: 1 },
    { id: secretId, provider_thread_id: secretId, subject: "SECRET SUBJECT", web_url: `https://mail.missiveapp.com/#inbox/${secretId}`, last_message_at: new Date(), total: 1 },
  ];
  acl = { [threadId]: { mailbox: "owner" } };
  sqlCalls = []; mutations = [];
  (globalThis as any).merchTestDb = fakeDb;
  (globalThis as any).merchTestPool = async (sql: string, params: any[] = []) => {
    sqlCalls.push(sql);
    let result: any[] = [];
    if (sql.startsWith("SELECT id FROM merch_opportunities")) result = rows.merch_opportunities.filter(r => r.id === params[0]);
    else if (sql.startsWith("SELECT id FROM chipply_stores")) result = rows.chipply_stores.filter(r => r.id === params[0]);
    else if (sql.includes("lower(provider_thread_id)")) {
      assert.match(sql, /provider='missive'/);
      result = threads.filter(t => t.provider_thread_id.toLowerCase() === params[0] || t.web_url === params[1]).slice(0, 1);
    } else if (sql.includes("SELECT subject, web_url")) {
      assert.ok(checkedReads.has(params[0]), "subject lookup must follow a successful current read check");
      result = threads.filter(t => t.id === params[0]);
    } else if (sql.includes("SELECT t.*, count(*)")) {
      for (const fragment of ["'read' = ANY(tg.capabilities)", "'search' = ANY(tg.capabilities)", "tg.revoked_at IS NULL", "tg.expires_at > now()", "p.protected = false", "gu.staff_id = $1::uuid"]) assert.ok(sql.includes(fragment), fragment);
      result = threads.filter(t => allowed(t.id, true));
    } else if (sql.includes("SELECT 1") && sql.includes("correspondence_threads")) {
      if (sql.includes("correspondence_thread_grants")) {
        for (const fragment of ["'read' = ANY(tg.capabilities)", "tg.revoked_at IS NULL", "tg.expires_at > now()", "p.protected = false"]) assert.ok(sql.includes(fragment), fragment);
        result = allowed(params[1], false, params[2]) ? [{ "?column?": 1 }] : [];
      } else result = threads.some(t => t.id === params[0]) ? [{}] : [];
      if (result.length) checkedReads.add(sql.includes("correspondence_thread_grants") ? params[1] : params[0]);
    } else if (sql.startsWith("DELETE FROM merch_opportunities")) {
      assert.match(sql, /archived=true AND chipply_store_id IS NULL AND event_id IS NULL AND NOT EXISTS/);
      result = rows.merch_opportunities.filter(o => o.id === params[0] && o.archived && !o.chipplyStoreId && !o.eventId && !rows.merch_thread_links.some(l => l.opportunityId === o.id));
      rows.merch_opportunities = rows.merch_opportunities.filter(o => !result.includes(o));
    } else throw new Error(`Unmocked SQL: ${sql}`);
    return { rows: result, rowCount: result.length };
  };
});
async function call(method: string, path: string, params: any = {}, body: any = {}, query: any = {}, actor = staff) {
  checkedReads = new Set();
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
  assert.ok(layer, `Actual route exists: ${method} ${path}`);
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(value: any) { resolve({ status: this.statusCode, body: value }); return this; }, end() { resolve({ status: this.statusCode, body: null }); } };
    layer.route.stack[0].handle({ params, body, query, staff: actor }, res, reject);
  });
}
const base = "/merch-pipeline/opportunities/:id/threads";
const storeBase = "/chipply/stores/:id/threads";
test("actual thread routes hide subjects, IDs, and counts; revocation takes effect on each list and unlink", async () => {
  const first = await call("GET", base, { id: oppId });
  assert.deepEqual(Object.keys(first.body), ["links"]);
  assert.equal(first.body.links.length, 1);
  assert.ok(!JSON.stringify(first.body).includes("SECRET"));
  assert.ok(!JSON.stringify(first.body).includes(secretId));
  acl[threadId] = { grant: ["read", "search"], revoked: true };
  assert.deepEqual((await call("GET", base, { id: oppId })).body, { links: [] });
  const denied = await call("DELETE", `${base}/:linkId`, { id: oppId, linkId }, { confirmed: true });
  assert.equal(denied.status, 404);
  assert.deepEqual(mutations, []);
});
test("actual authorization/search helper matrix: owner/workspace/group and active read+search grants", async () => {
  const cases = [
    [{ mailbox: "owner" }, true, true],
    [{ mailbox: "workspace" }, true, true],
    [{ mailbox: "workspace", protected: true }, false, false],
    [{ mailbox: "group", protected: true }, true, true],
    [{ grant: ["read"] }, true, false],
    [{ grant: ["search"] }, false, false],
    [{ grant: ["read", "search"] }, true, true],
    [{ grant: ["read", "search"], revoked: true }, false, false],
    [{ grant: ["read", "search"], expired: true }, false, false],
    [{}, false, false],
  ] as const;
  for (const [policy, read, search] of cases) {
    acl[threadId] = policy as any;
    assert.equal((await call("GET", base, { id: oppId })).body.links.length, read ? 1 : 0, JSON.stringify(policy));
    const found = await call("GET", base, { id: oppId }, {}, { search: "Store" });
    assert.deepEqual(Object.keys(found.body), ["suggestions"]);
    assert.equal(found.body.suggestions.length, search ? 1 : 0, JSON.stringify(policy));
    assert.ok(!JSON.stringify(found.body).includes("SECRET"));
  }
  acl[threadId] = { mailbox: "workspace" };
  assert.deepEqual((await call("GET", base, { id: oppId }, {}, {}, { ...staff, role: "manager" })).body, { links: [] });
  assert.equal((await call("GET", base, { id: oppId }, {}, {}, { ...staff, role: "admin" })).body.links.length, 2);
});
test("unreadable and nonexistent thread IDs have identical link errors and never insert", async () => {
  const denied = await call("POST", base, { id: oppId }, { confirmed: true, threadId: secretId });
  const nonexistent = await call("POST", base, { id: oppId }, { confirmed: true, threadId: unknownId });
  assert.deepEqual(denied, nonexistent);
  assert.equal(denied.status, 404); // Existing helper's generic nondisclosing convention.
  assert.deepEqual(mutations, []);
});
test("strict canonical Missive aliases cannot bypass ingested conversation ACL", async () => {
  const aliases = [`https://app.missiveapp.com/conversations/${secretId}`, `https://mail.missiveapp.com/#all/conversations/${secretId.toUpperCase()}`];
  for (const manualUrl of aliases) {
    assert.equal(missiveUrl.parse(manualUrl), `https://mail.missiveapp.com/#inbox/${secretId}`);
    assert.equal((await call("POST", base, { id: oppId }, { confirmed: true, manualUrl })).status, 404);
  }
  for (const manualUrl of [
    `https://mail.missiveapp.com/anything/${secretId}`,
    `https://mail.missiveapp.com/#inbox/${secretId}?x=1`,
    `https://mail.missiveapp.com/?redirect=evil#inbox/${secretId}`,
    `https://mail.missiveapp.com.evil.test/#inbox/${secretId}`,
    `https://user@mail.missiveapp.com/#inbox/${secretId}`,
    `http://mail.missiveapp.com/#inbox/${secretId}`,
    `https://mail.missiveapp.com:444/#inbox/${secretId}`,
  ]) assert.equal((await call("POST", base, { id: oppId }, { confirmed: true, manualUrl })).status, 400);
  assert.deepEqual(mutations, []);
  const permitted = await call("POST", base, { id: otherOpp }, { confirmed: true, manualUrl: `https://app.missiveapp.com/conversations/${providerId}` });
  assert.equal(permitted.status, 201);
  const stored = rows.merch_thread_links.find(l => l.id === permitted.body.id);
  assert.equal(stored.threadId, threadId);
  assert.equal(stored.manualUrl, null);
});
test("unknown manual URLs have no custom subject, and later ingestion/revocation is gated for list and unlink", async () => {
  const manualUrl = `https://mail.missiveapp.com/#inbox/${unknownId}`;
  assert.equal((await call("POST", base, { id: oppId }, { confirmed: true, manualUrl, subject: "SECRET" })).status, 400);
  const created = await call("POST", base, { id: oppId }, { confirmed: true, manualUrl });
  assert.equal(created.status, 201);
  assert.ok((await call("GET", base, { id: oppId })).body.links.some((l: any) => l.subject === "Manually linked Missive conversation"));
  threads.push({ id: unknownId, provider_thread_id: unknownId, subject: "LATER SECRET" });
  assert.equal((await call("GET", base, { id: oppId })).body.links.length, 1);
  assert.equal((await call("DELETE", `${base}/:linkId`, { id: oppId, linkId: created.body.id }, { confirmed: true })).status, 404);
});
test("link requires confirmation, authorized link/unlink succeeds, unrelated store cannot unlink it", async () => {
  assert.equal((await call("POST", base, { id: oppId }, { threadId })).status, 400);
  assert.equal((await call("POST", base, { id: oppId }, { confirmed: true, threadId })).status, 201);
  assert.equal((await call("DELETE", `${storeBase}/:linkId`, { id: otherStore, linkId }, { confirmed: true })).status, 404);
  rows.merch_opportunities[0].chipplyStoreId = storeId;
  assert.equal((await call("GET", storeBase, { id: storeId })).body.links.length, 1);
  assert.equal((await call("DELETE", `${storeBase}/:linkId`, { id: storeId, linkId }, {})).status, 400);
  assert.equal((await call("DELETE", `${storeBase}/:linkId`, { id: storeId, linkId }, { confirmed: true })).status, 204);
  assert.ok(rows.merch_thread_links.some(l => l.id === secretLink));
});
test("actual CRUD creates independently, exact six stages, patch preserves fields, archive/restore, safe confirmed delete", async () => {
  assert.deepEqual(stages, ["Target/Prospect/Inquiry", "Discovery", "Real Deal/Scheduled", "Gathering/Building", "Live", "Closed"]);
  const created = await call("POST", "/merch-pipeline/opportunities", {}, { name: "New prelaunch" });
  assert.equal(created.status, 201);
  assert.equal(created.body.chipplyStoreId, null);
  const path = "/merch-pipeline/opportunities/:id";
  for (const stage of stages) assert.equal((await call("PATCH", path, { id: oppId }, { stage })).body.stage, stage);
  assert.equal((await call("PATCH", path, { id: oppId }, { stage: "fake" })).status, 400);
  const archived = await call("PATCH", path, { id: oppId }, { archived: true });
  assert.equal(archived.body.ownerId, staffId);
  assert.equal(archived.body.nextAction, "Call team");
  assert.deepEqual(archived.body.details, { notes: "Keep notes" });
  assert.equal((await call("PATCH", path, { id: oppId }, { archived: false })).body.archived, false);
  assert.equal((await call("DELETE", path, { id: oppId }, { confirmed: true })).status, 409);
  await call("PATCH", path, { id: oppId }, { archived: true });
  assert.equal((await call("DELETE", path, { id: oppId }, { confirmed: true })).status, 409);
  rows.merch_thread_links = [];
  await call("PATCH", path, { id: oppId }, { chipplyStoreId: storeId });
  assert.equal((await call("DELETE", path, { id: oppId }, { confirmed: true })).status, 409);
  await call("PATCH", path, { id: oppId }, { chipplyStoreId: null, eventId: "553498" });
  assert.equal((await call("DELETE", path, { id: oppId }, { confirmed: true })).status, 409);
  await call("PATCH", path, { id: oppId }, { eventId: null });
  assert.equal((await call("DELETE", path, { id: oppId }, {})).status, 400);
  assert.equal((await call("DELETE", path, { id: oppId }, { confirmed: true })).status, 204);
});
test("store linkage preserves canonical opportunity and never mutates store or unrelated opportunity", async () => {
  const priorStore = JSON.stringify(rows.chipply_stores);
  const other = JSON.stringify(rows.merch_opportunities[1]);
  const path = "/merch-pipeline/opportunities/:id";
  const result = await call("PATCH", path, { id: oppId }, { chipplyStoreId: storeId, eventId: "553498" });
  assert.equal(result.body.id, oppId);
  assert.equal(JSON.stringify(rows.chipply_stores), priorStore);
  assert.equal(JSON.stringify(rows.merch_opportunities[1]), other);
  assert.equal((await call("PATCH", path, { id: oppId }, { chipplyStoreId: unknownId })).status, 404);
  assert.equal((await call("PATCH", path, { id: oppId }, { ownerId: unknownId })).status, 404);
  assert.equal((await call("PATCH", path, { id: oppId }, { storeName: "Attempt to change linked store" })).status, 400);
  assert.deepEqual(mutations, ["update:merch_opportunities"]);
});