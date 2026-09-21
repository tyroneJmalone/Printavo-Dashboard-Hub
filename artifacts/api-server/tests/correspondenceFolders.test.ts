import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { pool, type StaffUser } from "@workspace/db";
import correspondenceRouter from "../src/routes/correspondence.ts";

const suffix = randomUUID().slice(0, 8);
const ids = {
  staff: randomUUID(),
  visibleMailbox: randomUUID(),
  hiddenMailbox: randomUUID(),
  group: randomUUID(),
  inbox: randomUUID(),
  sent: randomUUID(),
  archived: randomUUID(),
  hidden: randomUUID(),
  granted: randomUUID(),
};
const actor: StaffUser = {
  id: ids.staff,
  email: `correspondence-${suffix}@example.test`,
  role: "manager",
  addedByEmail: null,
  createdAt: new Date(),
};
let server: ReturnType<express.Express["listen"]> | undefined;
let base = "";

before(async () => {
  await pool.query("INSERT INTO staff_users (id,email,role) VALUES ($1,$2,'manager')", [
    ids.staff,
    actor.email,
  ]);
  await pool.query(
    `INSERT INTO email_mailboxes (id,email,display_name,active) VALUES
       ($1,$2,'Visible correspondence fixture',false),
       ($3,$4,'Hidden correspondence fixture',false)`,
    [
      ids.visibleMailbox,
      `visible-${suffix}@example.test`,
      ids.hiddenMailbox,
      `hidden-${suffix}@example.test`,
    ],
  );
  await pool.query(
    `INSERT INTO email_mailbox_policies (mailbox_id,visibility,protected)
     VALUES ($1,'group',false),($2,'private',true)`,
    [ids.visibleMailbox, ids.hiddenMailbox],
  );
  await pool.query(
    "INSERT INTO email_access_groups (id,name,description) VALUES ($1,$2,'fixture')",
    [ids.group, `Correspondence ${suffix}`],
  );
  await pool.query(
    "INSERT INTO email_access_group_members (group_id,staff_id) VALUES ($1,$2)",
    [ids.group, ids.staff],
  );
  await pool.query(
    "INSERT INTO email_access_group_mailboxes (group_id,mailbox_id) VALUES ($1,$2)",
    [ids.group, ids.visibleMailbox],
  );
  await pool.query(
    `INSERT INTO correspondence_threads
       (id,mailbox_id,provider,provider_thread_id,subject,status,last_message_at)
     VALUES
       ($1,$6,'fixture','inbox-${suffix}','Inbox ${suffix}','open',now()),
       ($2,$6,'fixture','sent-${suffix}','Sent ${suffix}','open',now()-interval '1 minute'),
       ($3,$6,'fixture','archived-${suffix}','Archived ${suffix}','archived',now()-interval '2 minutes'),
       ($4,$7,'fixture','hidden-${suffix}','Hidden global ${suffix}','open',now()-interval '3 minutes'),
       ($5,$7,'fixture','granted-${suffix}','Granted global ${suffix}','open',now()-interval '4 minutes')`,
    [
      ids.inbox,
      ids.sent,
      ids.archived,
      ids.hidden,
      ids.granted,
      ids.visibleMailbox,
      ids.hiddenMailbox,
    ],
  );
  await pool.query(
    `INSERT INTO correspondence_messages
       (thread_id,mailbox_id,provider,provider_message_id,from_address,subject,body_text,delivered_at)
     VALUES
       ($1,$3,'fixture','sent-message-${suffix}',$4,'Sent body','global needle',now()),
       ($2,$5,'fixture','hidden-message-${suffix}','outside@example.test','Hidden body','global needle',now())`,
    [
      ids.sent,
      ids.hidden,
      ids.visibleMailbox,
      `visible-${suffix}@example.test`,
      ids.hiddenMailbox,
    ],
  );
  await pool.query(
    `INSERT INTO correspondence_thread_grants
       (thread_id,staff_id,source,capabilities,active)
     VALUES ($1,$2,'fixture',ARRAY['read','search','cite'],true)`,
    [ids.granted, ids.staff],
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.staff = actor;
    req.log = { error() {} } as typeof req.log;
    next();
  });
  app.use(correspondenceRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await pool.query("DELETE FROM email_mailboxes WHERE id=ANY($1::uuid[])", [
    [ids.visibleMailbox, ids.hiddenMailbox],
  ]);
  await pool.query("DELETE FROM email_access_groups WHERE id=$1", [ids.group]);
  await pool.query("DELETE FROM staff_users WHERE id=$1", [ids.staff]);
});

async function body(path: string) {
  const response = await fetch(`${base}${path}`);
  return { response, json: await response.json() as any };
}

test("selected mailbox is validated and scopes folder browsing", async () => {
  const selected = await body(
    `/correspondence/threads?folder=inbox&mailboxId=${ids.visibleMailbox}`,
  );
  assert.equal(selected.response.status, 200);
  assert.deepEqual(
    selected.json.threads.map((thread: any) => thread.id).sort(),
    [ids.inbox, ids.sent].sort(),
  );

  const denied = await body(
    `/correspondence/threads?folder=inbox&mailboxId=${ids.hiddenMailbox}`,
  );
  assert.equal(denied.response.status, 404);
  assert.match(denied.json.error, /not authorized/i);
});

test("sent uses an outgoing mailbox message and archived uses actual status", async () => {
  const sent = await body(
    `/correspondence/threads?folder=sent&mailboxId=${ids.visibleMailbox}`,
  );
  assert.deepEqual(sent.json.threads.map((thread: any) => thread.id), [ids.sent]);

  const archived = await body("/correspondence/threads?folder=archived");
  assert.deepEqual(archived.json.threads.map((thread: any) => thread.id), [ids.archived]);
});

test("global search ignores selectors and honors thread-level grants", async () => {
  const searched = await body(
    `/correspondence/threads?q=global%20needle&folder=archived&mailboxId=${ids.visibleMailbox}`,
  );
  assert.equal(searched.response.status, 200);
  assert.deepEqual(searched.json.threads.map((thread: any) => thread.id), [ids.sent]);

  const granted = await body(`/correspondence/threads?q=Granted%20global%20${suffix}`);
  assert.deepEqual(granted.json.threads.map((thread: any) => thread.id), [ids.granted]);

  const hidden = await body(`/correspondence/threads?q=Hidden%20global%20${suffix}`);
  assert.deepEqual(hidden.json.threads, []);

  const mailboxes = await body("/correspondence/mailboxes");
  assert.deepEqual(mailboxes.json.mailboxes.map((mailbox: any) => mailbox.id), [
    ids.visibleMailbox,
  ]);
});