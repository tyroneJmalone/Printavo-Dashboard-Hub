import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { pool, type StaffUser } from "@workspace/db";
import pipelineRouter, { literalLikePattern } from "../src/routes/pipeline.ts";

const suffix = randomUUID().slice(0, 8);
const users = {
  a: { id: randomUUID(), email: `pipeline-a-${suffix}@example.test`, role: "staff" },
  b: { id: randomUUID(), email: `pipeline-b-${suffix}@example.test`, role: "staff" },
};
const orderIds = [`pipeline-order-a-${suffix}`, `pipeline-order-b-${suffix}`];
const visualIds = [
  800_000_000 + (Number.parseInt(suffix.slice(0, 4), 16) * 2),
  800_000_001 + (Number.parseInt(suffix.slice(0, 4), 16) * 2),
];
const customerId = `pipeline-customer-${suffix}`;
let baseUrl = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;

async function cleanupFixtures() {
  await pool.query("DELETE FROM pipeline_views WHERE staff_id=ANY($1::uuid[])", [
    [users.a.id, users.b.id],
  ]);
  await pool.query("DELETE FROM pv_orders WHERE printavo_id=ANY($1::text[])", [orderIds]);
  await pool.query("DELETE FROM pv_customers WHERE printavo_id=$1", [customerId]);
  await pool.query("DELETE FROM staff_users WHERE id=ANY($1::uuid[])", [
    [users.a.id, users.b.id],
  ]);
}

before(async () => {
  await cleanupFixtures();
  await pool.query(
    `INSERT INTO staff_users (id,email,role) VALUES ($1,$2,'staff'),($3,$4,'staff')`,
    [users.a.id, users.a.email, users.b.id, users.b.email],
  );
  await pool.query(
    `INSERT INTO pv_customers (printavo_id,company_name,data,content_hash)
     VALUES ($1,'Percent % Company',$2::jsonb,$3)`,
    [customerId, "{}", `hash-${suffix}`],
  );
  await pool.query(
    `INSERT INTO pv_orders
      (printavo_id,visual_id,order_type,status_name,nickname,total,customer_id,
       customer_company,contact_name,owner_email,printavo_created_at,invoice_at,
       production_due_at,customer_due_at,data,content_hash,first_seen_at)
     VALUES
       ($1,$10,'invoice','Ready to go',concat('Literal % Job ',$9::text),100,$3,
       'Percent % Company','Ada Person',$4,'2020-01-16T02:00:00Z','2020-01-16',
        '2020-01-20T00:00:00Z','2020-01-22T00:00:00Z',$5::jsonb,$6,'2020-01-16T02:00:00Z'),
       ($2,$11,'invoice','Ready to go',concat('Ordinary Job ',$9::text),200,NULL,
        'Ordinary Company','Bob Person',$8,'2021-02-15T17:00:00Z','2021-02-16',
       '2021-02-20T00:00:00Z','2021-02-22T00:00:00Z',$5::jsonb,$7,'2021-02-15T17:00:00Z')`,
    [
      orderIds[0], orderIds[1], customerId, users.a.email,
      '{"totalQuantity":"5","privateSearchToken":"json-only-token"}',
      `order-hash-a-${suffix}`, `order-hash-b-${suffix}`, users.b.email, suffix,
      visualIds[0], visualIds[1],
    ],
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const selected = req.header("x-test-user") === "b" ? users.b : users.a;
    req.staff = {
      ...selected,
      clerkUserId: null,
      addedByEmail: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StaffUser;
    req.log = {
      error(value: { err?: Error }) {
        if (value.err) process.stderr.write(`pipeline test route error: ${value.err.message}\n`);
      },
    } as typeof req.log;
    next();
  });
  app.use(pipelineRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  await cleanupFixtures();
});

async function request(path: string, init: RequestInit = {}, user: "a" | "b" = "a") {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user": user,
      ...init.headers,
    },
  });
}

test("literal LIKE escaping treats percent and underscore as text", () => {
  assert.equal(literalLikePattern(String.raw`a%b_c\d`), String.raw`%a\%b\_c\\d%`);
});

test("explicit date filters override wonDays and are inclusive", async () => {
  const response = await request(
    `/pipeline?stage=won&invoiceFrom=2020-01-16&invoiceTo=2020-01-16&q=${suffix}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { rows: Array<{ visualId: number }> };
  assert.deepEqual(body.rows.map((row) => row.visualId), [visualIds[0]]);

  const easternCreated = await request(
    `/pipeline?stage=won&createdFrom=2020-01-15&createdTo=2020-01-15&q=${suffix}`,
  );
  const easternBody = await easternCreated.json() as { rows: Array<{ visualId: number }> };
  assert.deepEqual(easternBody.rows.map((row) => row.visualId), [visualIds[0]]);

  for (const range of [
    "productionDueFrom=2020-01-20&productionDueTo=2020-01-20",
    "customerDueFrom=2020-01-22&customerDueTo=2020-01-22",
  ]) {
    const dueResponse = await request(`/pipeline?stage=won&${range}&q=${suffix}`);
    assert.equal(dueResponse.status, 200);
    const dueBody = await dueResponse.json() as { rows: Array<{ visualId: number }> };
    assert.deepEqual(dueBody.rows.map((row) => row.visualId), [visualIds[0]]);
  }
});

test("search is literal, targeted, and shared by counters and rows", async () => {
  const response = await request(
    `/pipeline?stage=won&invoiceFrom=2019-01-01&q=%25&owner=${encodeURIComponent(users.a.email)}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    total: number;
    rows: Array<{ visualId: number }>;
    stages: Array<{ id: string; count: number; amount: number }>;
  };
  assert.equal(body.total, 1);
  assert.deepEqual(body.rows.map((row) => row.visualId), [visualIds[0]]);
  assert.deepEqual(
    body.stages.find((stage) => stage.id === "won"),
    { id: "won", label: "Won", count: 1, amount: 100 },
  );

  for (const [query, expected] of [
    [String(visualIds[0]), visualIds[0]],
    ["Ordinary Job", visualIds[1]],
    ["Ada Person", visualIds[0]],
    ["Percent % Company", visualIds[0]],
  ] as const) {
    const fieldResponse = await request(
      `/pipeline?stage=won&invoiceFrom=2019-01-01&q=${encodeURIComponent(query)}`,
    );
    assert.equal(fieldResponse.status, 200);
    const fieldBody = await fieldResponse.json() as { rows: Array<{ visualId: number }> };
    assert.deepEqual(fieldBody.rows.map((row) => row.visualId), [expected]);
  }

  for (const excluded of ["json-only-token", users.a.email, "Ready to go"]) {
    const excludedResponse = await request(
      `/pipeline?stage=won&invoiceFrom=2019-01-01&q=${encodeURIComponent(excluded)}`,
    );
    const excludedBody = await excludedResponse.json() as { total: number };
    assert.equal(excludedBody.total, 0);
  }

  const selectedOwner = await request(
    `/pipeline?stage=won&invoiceFrom=2019-01-01&q=${suffix}&owner=${encodeURIComponent(users.a.email)}`,
  );
  const selectedOwnerBody = await selectedOwner.json() as {
    rows: Array<{ visualId: number }>;
    owners: Array<{ email: string }>;
  };
  assert.deepEqual(selectedOwnerBody.rows.map((row) => row.visualId), [visualIds[0]]);
  assert.deepEqual(
    selectedOwnerBody.owners.map((owner) => owner.email).sort(),
    [users.a.email, users.b.email].sort(),
  );
});

test("dates and sort validation reject malformed and reversed input", async () => {
  assert.equal((await request("/pipeline?createdFrom=2024-02-30")).status, 400);
  assert.equal(
    (await request("/pipeline?invoiceFrom=2024-02-02&invoiceTo=2024-02-01")).status,
    400,
  );
  assert.equal((await request("/pipeline?sort=notAColumn")).status, 400);
  assert.equal((await request("/pipeline?createdFrom=")).status, 400);
  assert.equal((await request("/pipeline?direction=asc&direction=desc")).status, 400);
});

test("allowlisted sorting applies direction with stable results", async () => {
  const response = await request(
    `/pipeline?stage=won&invoiceFrom=2019-01-01&q=${suffix}&sort=total&direction=desc`,
  );
  const body = await response.json() as { rows: Array<{ visualId: number }> };
  assert.deepEqual(body.rows.map((row) => row.visualId), [visualIds[1], visualIds[0]]);

  const ascendingAge = await request(
    `/pipeline?stage=won&invoiceFrom=2019-01-01&q=${suffix}&sort=statusSince&direction=asc`,
  );
  const ascendingAgeBody = await ascendingAge.json() as { rows: Array<{ visualId: number }> };
  assert.deepEqual(ascendingAgeBody.rows.map((row) => row.visualId), [visualIds[1], visualIds[0]]);

  const descendingAge = await request(
    `/pipeline?stage=won&invoiceFrom=2019-01-01&q=${suffix}&sort=statusSince&direction=desc`,
  );
  const descendingAgeBody = await descendingAge.json() as { rows: Array<{ visualId: number }> };
  assert.deepEqual(descendingAgeBody.rows.map((row) => row.visualId), [visualIds[0], visualIds[1]]);
});

test("saved views are owner scoped and default switching is serialized", async () => {
  const first = await request("/pipeline/views", {
    method: "POST",
    body: JSON.stringify({ name: "First", config: { stage: "active" }, isDefault: false }),
  });
  assert.equal(first.status, 201);
  const firstView = await first.json() as { id: string; isDefault: boolean };
  assert.equal(firstView.isDefault, true);

  const crossPatch = await request(`/pipeline/views/${firstView.id}`, {
    method: "PATCH",
    body: JSON.stringify({ isDefault: true }),
  }, "b");
  assert.equal(crossPatch.status, 404);
  const crossDelete = await request(`/pipeline/views/${firstView.id}`, {
    method: "DELETE",
  }, "b");
  assert.equal(crossDelete.status, 404);
  const hidden = await request("/pipeline/views", {}, "b");
  assert.deepEqual(await hidden.json(), []);

  const creates = await Promise.all(["Second", "Third"].map((name) =>
    request("/pipeline/views", {
      method: "POST",
      body: JSON.stringify({ name, config: {}, isDefault: true }),
    }),
  ));
  assert.deepEqual(creates.map((response) => response.status), [201, 201]);
  const list = await (await request("/pipeline/views")).json() as Array<{ isDefault: boolean }>;
  assert.equal(list.filter((view) => view.isDefault).length, 1);

  const currentDefault = (await (await request("/pipeline/views")).json() as Array<{
    id: string;
    isDefault: boolean;
  }>).find((view) => view.isDefault);
  assert(currentDefault);
  const updated = await request(`/pipeline/views/${currentDefault.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: "Renamed",
      config: { q: "Ada", invoiceFrom: "2020-01-16", direction: "desc" },
      isDefault: false,
    }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as {
    name: string;
    config: Record<string, unknown>;
    isDefault: boolean;
  };
  assert.equal(updatedBody.name, "Renamed");
  assert.deepEqual(updatedBody.config, {
    q: "Ada",
    invoiceFrom: "2020-01-16",
    direction: "desc",
  });
  assert.equal(updatedBody.isDefault, false);
  const noDefault = await (await request("/pipeline/views")).json() as Array<{ isDefault: boolean }>;
  assert.equal(noDefault.some((view) => view.isDefault), false);

  const invalidCalendar = await request("/pipeline/views", {
    method: "POST",
    body: JSON.stringify({ name: "Invalid date", config: { createdFrom: "2024-02-30" } }),
  });
  assert.equal(invalidCalendar.status, 400);
  const invalidPagination = await request("/pipeline/views", {
    method: "POST",
    body: JSON.stringify({ name: "Invalid pagination", config: { limit: 10 } }),
  });
  assert.equal(invalidPagination.status, 400);

  const deleted = await request(`/pipeline/views/${firstView.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal((await request(`/pipeline/views/${firstView.id}`, {
    method: "DELETE",
  })).status, 404);

  const index = await pool.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE indexname='pipeline_views_one_default_per_staff_uq'",
  );
  assert.match(index.rows[0].indexdef, /UNIQUE INDEX.*WHERE \(is_default = true\)/);
});