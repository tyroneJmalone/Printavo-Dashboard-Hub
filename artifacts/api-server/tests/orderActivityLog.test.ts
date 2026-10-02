import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import orderActivityLogRouter from "../src/routes/orderActivityLog";
import { MODULE_DEFS, moduleAccessGate } from "../src/lib/auth/moduleAccess";
import { fixture } from "./orderActivityLogDbFixture";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ActivityInputError, activityDate, boundedInteger, conversionIdentitySql,
  decodeActivityCursor, encodeActivityCursor, printingAllowed, safeActivityValue,
} from "../src/lib/orderActivityLog";

test("pagination is bounded and rejects malformed query values", () => {
  assert.equal(boundedInteger(undefined, 25, 1, 100), 25);
  assert.equal(boundedInteger("100", 25, 1, 100), 100);
  for (const input of ["0", "101", "-1", "1.5", "Infinity", ["5"]]) {
    assert.throws(() => boundedInteger(input, 25, 1, 100), ActivityInputError);
  }
});
test("date filters reject invalid or ambiguous dates", () => {
  assert.equal(activityDate("2026-01-03"), "2026-01-03T00:00:00.000Z");
  for (const value of ["2026-02-30", "yesterday", "2026-01-03T05:00:00+02:00", ["2026-01-03"]]) {
    assert.throws(() => activityDate(value), ActivityInputError);
  }
});
test("unified cursor round-trips equal-time source/id ordering keys and binds identity/filter/access", () => {
  const cursor = { v: 1 as const, scope: '["order-a","all",null,null,false]',
    time: "2026-01-03T00:00:00.123Z", source: "pv_files", id: "file:mirrored" };
  const encoded = encodeActivityCursor(cursor);
  assert.deepEqual(decodeActivityCursor(encoded, cursor.scope), cursor);
  assert.throws(() => decodeActivityCursor(encoded, "another-order-or-filter"), ActivityInputError);
  for (const bad of ["%%", "", encodeActivityCursor({ ...cursor, source: "emails" }),
    encodeActivityCursor({ ...cursor, time: "invalid" }), encodeActivityCursor({ ...cursor, id: "" })]) {
    assert.throws(() => decodeActivityCursor(bad, cursor.scope), ActivityInputError);
  }
});
test("printing requires production readiness, not Reports/Payments readiness", () => {
  assert.equal(printingAllowed("admin", new Set()), true);
  assert.equal(printingAllowed("staff", new Set(["production"])), true);
  assert.equal(printingAllowed("manager", new Set(["reports", "payments"])), false);
  assert.equal(printingAllowed(undefined, new Set()), false);
});
test("conversion lineage requires exact recorded IDs, matching customer, and versioned quote evidence", () => {
  const query = new PgDialect().sqlToQuery(conversionIdentitySql("customer-1"));
  assert.match(query.sql, /quoteHistoryVersion/);
  assert.match(query.sql, /new_value->>'printavoId' = c.entity_id/);
  assert.match(query.sql, /old_value->>'orderType' = 'quote'/);
  assert.match(query.sql, /new_value->>'orderType' = 'invoice'/);
  assert.equal(query.sql.includes("visual_id"), false);
  assert.deepEqual(query.params, ["customer-1", "customer-1"]);
});
test("before and after values are safe strings/null, not email or metadata payloads", () => {
  assert.equal(safeActivityValue(null), null);
  assert.equal(safeActivityValue(12), "12");
  const safe = safeActivityValue({ email: "secret@example.com", sourceUrl: "https://private",
    snapshot_metadata: { secret: true }, quantity: 12, description: "Contact secret@example.com" });
  assert.equal(safe, '{"quantity":12,"description":"Contact [email omitted]"}');
});

test("Reports alone claims the dedicated prefix without changing existing Reports claims", () => {
  assert.deepEqual(MODULE_DEFS.filter(def => def.apiPrefixes.includes("/order-activity-log")).map(def => def.key), ["reports"]);
  assert.equal(MODULE_DEFS.find(def => def.key === "reports")?.apiPrefixes.includes("/reports"), true);
});

async function apiRequest(path: string, role = "admin") {
  const app = express();
  app.use((req, _res, next) => {
    req.staff = { role } as never;
    req.log = { error() {} } as never;
    next();
  });
  app.use(moduleAccessGate);
  app.use(orderActivityLogRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}
const timelineEvent = (source: string, id: string) => ({
  source, id, category: "order", time: new Date("2026-01-03T00:00:00.123Z"),
  kind: "observation", title: "Order updated", description: "nickname", old_value: "old", new_value: "new",
});

test("search API parameterizes visual number, customer/contact/nickname and pagination, including empty recent search", async () => {
  fixture.queries = [];
  fixture.responses = [{ rows: [] }, { rows: [{ total: 0 }] }];
  assert.equal((await apiRequest("/order-activity-log/orders?search=%23123&limit=10&offset=20")).status, 200);
  assert(fixture.queries[0].params.includes(123));
  assert(fixture.queries[0].params.includes("%#123%"));
  assert.match(fixture.queries[0].sql, /contact_name ILIKE/);
  assert.match(fixture.queries[0].sql, /nickname ILIKE/);
  fixture.responses = [{ rows: [] }, { rows: [{ total: 0 }] }];
  assert.deepEqual((await apiRequest("/order-activity-log/orders")).body, { orders: [], total: 0 });
  assert.match(fixture.queries[2].sql, /WHERE TRUE/);
  assert.equal(fixture.queries[2].sql.includes("printavo_created_at"), false);
});

test("timeline API uses bounded unified SQL and a validated deterministic cursor, not visual identity", async () => {
  fixture.queries = [];
  fixture.responses = [{ rows: [timelineEvent("pv_files", "file:mirrored"), timelineEvent("change_events", "12")] },
    { rows: [{ observed_at: new Date("2026-01-01T00:00:00Z") }] }, { rows: [{ linked: true, unverified: false }] }];
  const first = await apiRequest("/order-activity-log/orders/invoice-1?limit=1&start=2026-01-01&category=all");
  assert.equal(first.status, 200);
  assert.equal(first.body.events.length, 1);
  assert.equal(first.body.events[0].id, "pv_files:file:mirrored");
  assert.equal(first.body.coverage.baselineObservedAt, "2026-01-01T00:00:00.000Z");
  const query = fixture.queries[0];
  assert.equal(query.sql.includes("visual_id"), false);
  assert.equal((query.sql.match(/LIMIT /g) ?? []).length, 5);
  assert.match(query.sql, /c\.order_id IN/);
  assert.match(query.sql, /pq_print_jobs/);
  assert.equal(query.sql.includes("snapshot_metadata"), false);
  fixture.responses = [{ rows: [] }, { rows: [] }, { rows: [{ linked: false }] }];
  const next = await apiRequest(`/order-activity-log/orders/invoice-1?limit=1&start=2026-01-01&category=all&cursor=${first.body.nextCursor}`);
  assert.equal(next.status, 200);
  assert.equal(next.body.nextCursor, null);
  assert.match(fixture.queries[3].sql, /\(time, source COLLATE "C", id COLLATE "C"\) </);
  assert.equal((await apiRequest(`/order-activity-log/orders/other?cursor=${first.body.nextCursor}`)).status, 400);
});

test("staff Reports access omits printing even when requested and explains the omission", async () => {
  fixture.queries = [];
  fixture.responses = [{ rows: [] }, { rows: [] }, { rows: [{ linked: false }] }];
  const result = await apiRequest("/order-activity-log/orders/invoice-1?category=printing", "staff");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.events, []);
  assert.equal(fixture.queries[0].sql.includes("pq_print_jobs"), false);
  assert(result.body.coverage.notes.some((note: string) => note.includes("Production access")));
});

test("missing orders, invalid queries, and failed source queries fail explicitly", async () => {
  const original = fixture.order;
  fixture.order = null;
  assert.equal((await apiRequest("/order-activity-log/orders/missing")).status, 404);
  fixture.order = original;
  assert.equal((await apiRequest("/order-activity-log/orders/invoice-1?category=email")).status, 400);
  assert.equal((await apiRequest("/order-activity-log/orders?limit=1001")).status, 400);
  assert.equal((await apiRequest("/order-activity-log/orders/invoice-1?start=2026-02-01&end=2026-01-01")).status, 400);
  fixture.responses = [new Error("Source unavailable"), { rows: [] }, { rows: [] }];
  const result = await apiRequest("/order-activity-log/orders/invoice-1");
  assert.equal(result.status, 500);
  assert.match(result.body.error, /Failed to load/);
});

test("generated unified, baseline, lineage and search SQL execute in a real read-only database transaction", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  fixture.queries = [];
  fixture.responses = [{ rows: [] }, { rows: [] }, { rows: [{ linked: false }] }];
  assert.equal((await apiRequest("/order-activity-log/orders/invoice-1?start=2026-01-01&end=2026-12-31&category=all")).status, 200);
  fixture.responses = [{ rows: [] }, { rows: [{ total: 0 }] }];
  assert.equal((await apiRequest("/order-activity-log/orders?search=%23123")).status, 200);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    for (const query of fixture.queries) await client.query(query.sql, query.params);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});