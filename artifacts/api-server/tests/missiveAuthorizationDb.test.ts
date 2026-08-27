import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import { pool, type StaffUser } from "@workspace/db";
import {
  authorizedMailboxIds,
  canReadMailbox,
  canReadThread,
} from "../src/lib/emailAccess/authorization.ts";
import {
  customerEmailStats,
  customerThreads,
} from "../src/lib/emailActivity/matching.ts";
import { hasStaffCapability } from "../src/middlewares/requireStaff.ts";
import emailActivityRouter from "../src/routes/emailActivity.ts";

const suffix = randomUUID().slice(0, 8);
const ids = {
  owner: randomUUID(),
  admin: randomUUID(),
  manager: randomUUID(),
  emptyManager: randomUUID(),
  staff: randomUUID(),
  protectedMailbox: randomUUID(),
  groupMailbox: randomUUID(),
  workspaceMailbox: randomUUID(),
  group: randomUUID(),
  thread: randomUUID(),
  hiddenThread: randomUUID(),
  groupThread: randomUUID(),
};
const customerId = `customer-${suffix}`;
const visibleGmailThreadId = `gmail-visible-${suffix}`;
const hiddenGmailThreadId = `gmail-hidden-${suffix}`;

function isoOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const users: Record<"owner" | "admin" | "manager" | "emptyManager" | "staff", StaffUser> = {
  owner: {
    id: ids.owner,
    email: `acl-owner-${suffix}@example.test`,
    role: "staff",
    addedByEmail: null,
    createdAt: new Date(),
  },
  admin: {
    id: ids.admin,
    email: `acl-admin-${suffix}@example.test`,
    role: "admin",
    addedByEmail: null,
    createdAt: new Date(),
  },
  manager: {
    id: ids.manager,
    email: `acl-manager-${suffix}@example.test`,
    role: "manager",
    addedByEmail: null,
    createdAt: new Date(),
  },
  emptyManager: {
    id: ids.emptyManager,
    email: `acl-empty-manager-${suffix}@example.test`,
    role: "manager",
    addedByEmail: null,
    createdAt: new Date(),
  },
  staff: {
    id: ids.staff,
    email: `acl-staff-${suffix}@example.test`,
    role: "staff",
    addedByEmail: null,
    createdAt: new Date(),
  },
};

before(async () => {
  await pool.query(
    `INSERT INTO staff_users (id, email, role)
     VALUES ($1,$2,'staff'), ($3,$4,'admin'), ($5,$6,'manager'), ($7,$8,'staff'),
            ($9,$10,'manager')`,
    [
      ids.owner,
      users.owner.email,
      ids.admin,
      users.admin.email,
      ids.manager,
      users.manager.email,
      ids.staff,
      users.staff.email,
      ids.emptyManager,
      users.emptyManager.email,
    ],
  );
  await pool.query(
    `INSERT INTO email_mailboxes (id, email, display_name, active)
     VALUES
       ($1,$2,'Protected fixture',false),
       ($3,$4,'Group fixture',false),
       ($5,$6,'Workspace fixture',false)`,
    [
      ids.protectedMailbox,
      `acl-protected-${suffix}@example.test`,
      ids.groupMailbox,
      `acl-group-${suffix}@example.test`,
      ids.workspaceMailbox,
      `acl-workspace-${suffix}@example.test`,
    ],
  );
  await pool.query(
    `INSERT INTO email_messages
       (mailbox_id, gmail_id, gmail_thread_id, direction, subject, internal_date, excluded_reason)
     VALUES
       ($1,$2,$3,'inbound','Authorized aggregate fixture',now()-interval '3 days',NULL),
       ($1,$4,$3,'outbound','Authorized aggregate fixture',now()-interval '2 days',NULL),
       ($1,$5,$6,'inbound','Authorized unanswered fixture',now()-interval '4 days',NULL),
       ($1,$7,$8,'outbound','Authorized filtered fixture',now()-interval '1 day','fixture-authorized'),
       ($9,$10,$11,'inbound','Unauthorized aggregate fixture',now()-interval '3 days',NULL),
       ($9,$12,$11,'outbound','Unauthorized aggregate fixture',now()-interval '2 days',NULL),
       ($9,$13,$14,'inbound','Unauthorized unanswered fixture',now()-interval '4 days',NULL),
       ($9,$15,$16,'outbound','Unauthorized filtered fixture',now()-interval '1 day','fixture-unauthorized')`,
    [
      ids.groupMailbox,
      `aggregate-auth-in-${suffix}`,
      `aggregate-auth-thread-${suffix}`,
      `aggregate-auth-out-${suffix}`,
      `aggregate-auth-unanswered-${suffix}`,
      `aggregate-auth-unanswered-thread-${suffix}`,
      `aggregate-auth-filtered-${suffix}`,
      `aggregate-auth-filtered-thread-${suffix}`,
      ids.protectedMailbox,
      `aggregate-hidden-in-${suffix}`,
      `aggregate-hidden-thread-${suffix}`,
      `aggregate-hidden-out-${suffix}`,
      `aggregate-hidden-unanswered-${suffix}`,
      `aggregate-hidden-unanswered-thread-${suffix}`,
      `aggregate-hidden-filtered-${suffix}`,
      `aggregate-hidden-filtered-thread-${suffix}`,
    ],
  );
  await pool.query(
    `INSERT INTO email_thread_customers
       (mailbox_id, gmail_thread_id, printavo_customer_id, source)
     VALUES ($1,$2,$4,'fixture'), ($3,$5,$4,'fixture')`,
    [
      ids.groupMailbox,
      `aggregate-auth-thread-${suffix}`,
      ids.protectedMailbox,
      customerId,
      `aggregate-hidden-thread-${suffix}`,
    ],
  );
  await pool.query(
    `INSERT INTO email_mailbox_policies
       (mailbox_id, owner_staff_id, visibility, protected)
     VALUES
       ($1,$2,'private',true),
       ($3,NULL,'group',false),
       ($4,NULL,'workspace',false)`,
    [ids.protectedMailbox, ids.owner, ids.groupMailbox, ids.workspaceMailbox],
  );
  await pool.query(
    `INSERT INTO email_access_groups (id, name, description)
     VALUES ($1,$2,'authorization test fixture')`,
    [ids.group, `ACL fixture ${suffix}`],
  );
  await pool.query(
    `INSERT INTO email_access_group_members (group_id, staff_id) VALUES ($1,$2)`,
    [ids.group, ids.manager],
  );
  await pool.query(
    `INSERT INTO email_access_group_mailboxes (group_id, mailbox_id) VALUES ($1,$2)`,
    [ids.group, ids.groupMailbox],
  );
  await pool.query(
    `INSERT INTO correspondence_threads
       (id, mailbox_id, provider, provider_thread_id, gmail_thread_id, subject, last_message_at)
     VALUES
       ($1,$2,'fixture',$3,$4,'Protected fixture thread',now()),
       ($5,$2,'fixture',$6,$7,'Hidden fixture thread',now())`,
    [
      ids.thread,
      ids.protectedMailbox,
      `thread-${suffix}`,
      visibleGmailThreadId,
      ids.hiddenThread,
      `hidden-thread-${suffix}`,
      hiddenGmailThreadId,
    ],
  );
  await pool.query(
    `INSERT INTO email_messages
       (mailbox_id, gmail_id, gmail_thread_id, direction, subject, internal_date)
     VALUES
       ($1,$2,$3,'inbound','Grant visible customer thread',now()),
       ($1,$4,$5,'inbound','Hidden customer thread',now())`,
    [
      ids.protectedMailbox,
      `message-visible-${suffix}`,
      visibleGmailThreadId,
      `message-hidden-${suffix}`,
      hiddenGmailThreadId,
    ],
  );
  await pool.query(
    `INSERT INTO email_thread_customers
       (mailbox_id, gmail_thread_id, printavo_customer_id, source)
     VALUES ($1,$2,$4,'manual'), ($1,$3,$4,'manual')`,
    [
      ids.protectedMailbox,
      visibleGmailThreadId,
      hiddenGmailThreadId,
      customerId,
    ],
  );
});

after(async () => {
  await pool.query("DELETE FROM email_mailboxes WHERE id = ANY($1::uuid[])", [
    [ids.protectedMailbox, ids.groupMailbox, ids.workspaceMailbox],
  ]);
  await pool.query("DELETE FROM email_access_groups WHERE id=$1", [ids.group]);
  await pool.query("DELETE FROM staff_users WHERE id = ANY($1::uuid[])", [
    [ids.owner, ids.admin, ids.manager, ids.emptyManager, ids.staff],
  ]);
});

test("admin role has full access to every mailbox and thread", async () => {
  assert.equal(await canReadMailbox(users.admin, ids.protectedMailbox), true);
  assert.equal(await canReadThread(users.admin, ids.thread), true);
  const visible = await authorizedMailboxIds(users.admin);
  assert.equal(visible.includes(ids.protectedMailbox), true);
  assert.equal(visible.includes(ids.groupMailbox), true);
  assert.equal(visible.includes(ids.workspaceMailbox), true);
});

test("Email Activity analytics capability excludes staff and includes manager/admin", () => {
  assert.equal(hasStaffCapability(users.staff, "view_email_activity"), false);
  assert.equal(hasStaffCapability(users.manager, "view_email_activity"), true);
  assert.equal(hasStaffCapability(users.admin, "view_email_activity"), true);
});

test("every analytics route registers the capability gate", async () => {
  const source = await readFile("src/routes/emailActivity.ts", "utf8");
  const paths = [
    "/email-activity/stats",
    "/email-activity/response-times",
    "/email-activity/unanswered",
    "/email-activity/heatmap",
    "/email-activity/filtered",
    "/email-activity/customers",
    "/email-activity/deals-report",
  ];
  for (const path of paths) {
    assert.match(
      source,
      new RegExp(
        `router\\.get\\(\\"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\",\\s*requireCapability\\(\\"view_email_activity\\"\\)`,
      ),
      path,
    );
  }
});

test("mailbox owner can read protected content", async () => {
  assert.equal(await canReadMailbox(users.owner, ids.protectedMailbox), true);
  assert.equal(await canReadThread(users.owner, ids.thread), true);
});

test("group membership grants only its configured mailbox", async () => {
  assert.equal(await canReadMailbox(users.manager, ids.groupMailbox), true);
  assert.equal(await canReadMailbox(users.manager, ids.protectedMailbox), false);
  assert.equal(await canReadMailbox(users.manager, ids.workspaceMailbox), false);
  const visible = await authorizedMailboxIds(users.manager);
  assert.equal(visible.includes(ids.groupMailbox), true);
  assert.equal(visible.includes(ids.protectedMailbox), false);
});

test("all-mailbox analytics endpoints stay inside the server-derived ACL scope", async () => {
  let actor = users.manager;
  const app = express();
  app.use((req, _res, next) => {
    req.staff = actor;
    next();
  });
  app.use(emailActivityRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const range = `start=${isoOffset(-10)}&end=${isoOffset(0)}`;
  const paths = [
    `/email-activity/stats?granularity=daily&${range}`,
    `/email-activity/response-times?${range}`,
    "/email-activity/unanswered",
    `/email-activity/heatmap?${range}`,
    `/email-activity/filtered?${range}`,
    `/email-activity/customers?${range}`,
  ];

  try {
    const responses = await Promise.all(paths.map((path) => fetch(`${base}${path}`)));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200, 200]);
    const [stats, responseTimes, unanswered, heatmap, filtered, customers] =
      await Promise.all(responses.map((response) => response.json())) as any[];

    assert.deepEqual(stats.people.map((row: any) => row.mailboxId), [ids.groupMailbox]);
    assert.equal(stats.series.every((row: any) => row.mailboxId === ids.groupMailbox), true);
    assert.deepEqual(responseTimes.people.map((row: any) => row.mailboxId), [ids.groupMailbox]);
    assert.equal(unanswered.threads.length > 0, true);
    assert.equal(unanswered.threads.every((row: any) => row.mailboxId === ids.groupMailbox), true);
    assert.equal(heatmap.cells.reduce((sum: number, cell: any) => sum + cell.sent + cell.received, 0), 3);
    assert.deepEqual(filtered.breakdown, [{ reason: "fixture-authorized", count: 1 }]);
    assert.equal(filtered.sample.every((row: any) => row.mailboxId === ids.groupMailbox), true);
    assert.equal(customers.customers.length, 1);
    assert.equal(customers.customers[0].messages, 2);

    const denied = await fetch(
      `${base}/email-activity/stats?granularity=daily&${range}&mailboxId=${ids.protectedMailbox}`,
    );
    assert.equal(denied.status, 404);

    actor = users.emptyManager;
    const emptyResponses = await Promise.all(paths.map((path) => fetch(`${base}${path}`)));
    assert.deepEqual(emptyResponses.map((response) => response.status), [200, 200, 200, 200, 200, 200]);
    const [emptyStats, emptyResponseTimes, emptyUnanswered, emptyHeatmap, emptyFiltered, emptyCustomers] =
      await Promise.all(emptyResponses.map((response) => response.json())) as any[];
    assert.deepEqual(emptyStats.people, []);
    assert.deepEqual(emptyResponseTimes.people, []);
    assert.deepEqual(emptyUnanswered.threads, []);
    assert.deepEqual(emptyHeatmap.cells, []);
    assert.equal(emptyFiltered.total, 0);
    assert.deepEqual(emptyCustomers.customers, []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("non-protected workspace mailbox is visible to staff", async () => {
  assert.equal(await canReadMailbox(users.staff, ids.workspaceMailbox), true);
  assert.equal(await canReadMailbox(users.staff, ids.groupMailbox), false);
});

test("thread grants grant, expire, and revoke without opening the mailbox", async () => {
  await pool.query(
    `INSERT INTO correspondence_thread_grants
       (thread_id, staff_id, source, capabilities, active)
     VALUES ($1,$2,'fixture',ARRAY['read','search','cite'],true)`,
    [ids.thread, ids.staff],
  );
  assert.equal(await canReadMailbox(users.staff, ids.protectedMailbox), false);
  assert.equal(await canReadThread(users.staff, ids.thread), true);

  await pool.query(
    `UPDATE correspondence_thread_grants
        SET expires_at=now()-interval '1 second'
      WHERE thread_id=$1 AND staff_id=$2 AND source='fixture'`,
    [ids.thread, ids.staff],
  );
  assert.equal(await canReadThread(users.staff, ids.thread), false);

  await pool.query(
    `UPDATE correspondence_thread_grants
        SET expires_at=NULL, revoked_at=now(), active=false
      WHERE thread_id=$1 AND staff_id=$2 AND source='fixture'`,
    [ids.thread, ids.staff],
  );
  assert.equal(await canReadThread(users.staff, ids.thread), false);
});

test("customer history includes only the explicitly granted thread", async () => {
  await pool.query(
    `INSERT INTO correspondence_thread_grants
       (thread_id, staff_id, source, capabilities, active)
     VALUES ($1,$2,'customer-fixture',ARRAY['read'],true)`,
    [ids.thread, ids.staff],
  );

  const threads = await customerThreads(customerId, ids.staff, []);
  assert.deepEqual(threads.map((thread) => thread.gmail_thread_id), [
    visibleGmailThreadId,
  ]);
  const stats = await customerEmailStats(customerId, ids.staff, []);
  assert.equal(stats.thread_count, 1);
  assert.equal(stats.message_count, 1);

  await pool.query(
    `DELETE FROM correspondence_thread_grants
      WHERE thread_id=$1 AND staff_id=$2 AND source='customer-fixture'`,
    [ids.thread, ids.staff],
  );
});