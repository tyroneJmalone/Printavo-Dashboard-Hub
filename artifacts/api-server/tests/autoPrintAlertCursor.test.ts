import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns } from "drizzle-orm";
import { pqPrintJobsTable } from "@workspace/db";
import { ALERT_BATCH_SIZE, collectAlertPage, nextAlertCursor, type AlertCursor, type AlertPosition } from "../src/lib/printQueue/autoPrint/alertCursor";
import { readAlertPage, collectAutoPrintAlerts, evidenceEvents } from "../src/lib/printQueue/autoPrint/alerts";
import { jobAlertEvents, type AlertJob } from "../src/lib/printQueue/autoPrint/alertEvents";

const activation = new Date("2026-10-01T00:00:00Z");
const position = (i: number): AlertPosition => ({ at: `2026-10-02 00:00:00.${String(i).padStart(6, "0")}+00`, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` });

/** Mock transactional durable store: independent worker instances share only this
 * state, like separate processes. Nothing imports printer or mutation services. */
class Store {
  rows: AlertPosition[] = [];
  cursors = new Map<string, AlertCursor>();
  delivered = new Set<string>();
  locked = new Set<string>();
  largestPage = 0;
  failAt: string | undefined;
  async tick(lane = "forward", pause?: () => Promise<void>) {
    if (this.locked.has(lane)) return;
    this.locked.add(lane);
    const prior = structuredClone(this.cursors.get(lane) ?? {});
    const staged = new Set(this.delivered);
    let next = prior;
    try {
      await collectAlertPage({
        read: async () => {
          if (pause) await pause();
          const rows = this.rows.filter(r => new Date(r.at) >= activation && (!prior.after || r.at > prior.after.at || r.at === prior.after.at && r.id > prior.after.id))
            .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(0, ALERT_BATCH_SIZE);
          this.largestPage = Math.max(this.largestPage, rows.length);
          return { items: rows, next: nextAlertCursor(rows, prior, lane === "reconcile") };
        },
        deliver: async rows => {
          for (const row of rows) {
            if (row.id === this.failAt) throw new Error("delivery unavailable");
            staged.add(row.id);
          }
        },
        checkpoint: async cursor => { next = structuredClone(cursor); },
      });
      for (const id of staged) this.delivered.add(id);
      this.cursors.set(lane, next);
    } finally { this.locked.delete(lane); }
  }
}

test("out-of-order commits behind the high water mark are recovered by reconciliation", async () => {
  const store = new Store();
  store.rows = [position(2), position(3)];
  await store.tick(); await store.tick("reconcile");
  store.rows.push(position(1)); // transaction committed after both cursors passed it
  await store.tick(); assert.equal(store.delivered.size, 2);
  await store.tick("reconcile"); // wrap
  await store.tick("reconcile");
  assert.equal(store.delivered.size, 3);
});
test("long downtime drains bounded pages, and a restart resumes the committed cursor", async () => {
  const store = new Store();
  store.rows = Array.from({ length: 1007 }, (_, i) => position(i + 1));
  store.rows.unshift({ ...position(0), at: "2026-09-01 00:00:00+00" });
  await store.tick();
  const restarted = new Store();
  restarted.rows = store.rows; restarted.cursors = store.cursors; restarted.delivered = store.delivered;
  for (let i = 0; i < 30; i++) await restarted.tick();
  assert.equal(restarted.delivered.size, 1007);
  assert.equal(restarted.largestPage, ALERT_BATCH_SIZE);
  assert.deepEqual(restarted.cursors.get("forward")?.after, position(1007));
});
test("delivery failure cannot checkpoint past evidence, including partially staged inserts", async () => {
  const store = new Store();
  store.rows = [position(1), position(2), position(3)];
  store.failAt = position(2).id;
  await assert.rejects(store.tick(), /delivery unavailable/);
  assert.equal(store.delivered.size, 0);
  assert.equal(store.cursors.size, 0);
  store.failAt = undefined;
  await store.tick();
  assert.equal(store.delivered.size, 3);
});
test("concurrent workers skip locked pages; overlapping lanes keep unique delivery", async () => {
  const store = new Store();
  store.rows = [position(1), position(2)];
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const owner = store.tick("forward", () => paused);
  await store.tick("forward");
  assert.equal(store.cursors.size, 0);
  await store.tick("reconcile");
  release(); await owner;
  assert.equal(store.delivered.size, 2);
  assert.deepEqual(store.cursors.get("forward")?.after, position(2));
});

/** Use the actual Drizzle SQL adapter with a scripted pg client, not a second
 * implementation of production queries. Rows use pg's requested array mode. */
function mockDb(replies: unknown[][]) {
  const statements: { text: string; values: unknown[] }[] = [];
  const client = {
    query: async (query: string | { text: string }, values: unknown[] = []) => {
      const text = typeof query === "string" ? query : query.text;
      statements.push({ text, values });
      return { rows: replies.shift() ?? [], rowCount: 0 };
    },
  };
  return { db: drizzle(client as any), statements };
}
test("production hydration preserves the first failure after success and decodes raw SQL timestamps", async () => {
  const p = position(1);
  const job: Record<string, unknown> = { id: p.id, runId: position(2).id, docType: "workorder",
    status: "printed", createdAt: p.at, errorMessage: null, visualId: "22251" };
  const row = Object.keys(getTableColumns(pqPrintJobsTable)).map(k => job[k] ?? null);
  const mock = mockDb([[row], [], [{ jobId: p.id, outcome: "retry_pending", error: "first failure",
    phase: "render", startedAt: p.at, finishedAt: p.at }], []]);
  const events = await evidenceEvents(mock.db as any, [{ jobId: p.id }], activation);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "failure");
  assert.equal(events[0].payload.reason, "first failure");
  assert.equal(events[0].payload.occurredAt, new Date(p.at).toISOString());
  assert.match(mock.statements[2].text, /cross join lateral/);
  assert.match(mock.statements[2].text, /limit 1/);
});
test("production query keeps timestamp precision, keyset ordering, activation and SQL LIMIT", async () => {
  const p = position(1);
  const mock = mockDb([[[p.id, p.at]]]);
  const cursor = { after: position(0), through: "2026-10-03T00:00:00Z" };
  const page = await readAlertPage(mock.db as any, "jobs", cursor, activation, true);
  assert.deepEqual(page.next, { after: p, through: cursor.through });
  assert.match(mock.statements[0].text, /created_at.*::text/);
  assert.match(mock.statements[0].text, /::timestamptz/);
  assert.match(mock.statements[0].text, /order by.*created_at.*id.*limit/);
  assert.ok(mock.statements[0].values.includes(ALERT_BATCH_SIZE));
  assert.ok(mock.statements[0].values.includes(position(0).at));
});
test("a large run fanout persists its subcursor instead of skipping jobs", async () => {
  const p = position(1);
  const ids = Array.from({ length: ALERT_BATCH_SIZE }, (_, i) => [position(i + 2).id]);
  const first = mockDb([[[p.id, p.at]], ids]);
  const page = await readAlertPage(first.db as any, "runs", {}, activation, false);
  assert.equal(page.items.length, ALERT_BATCH_SIZE + 1);
  assert.equal(page.next.after, undefined);
  assert.equal(page.next.run?.jobAfter, ids[ids.length - 1][0]);
  const second = mockDb([[[position(100).id]]]);
  const end = await readAlertPage(second.db as any, "runs", page.next, activation, false);
  assert.deepEqual(end.next.after, p);
  assert.equal(end.next.run, undefined);
  assert.match(second.statements[0].text, /run_id.*and.*id.*>/);
});
test("active fence lane revisits old eligible jobs and keeps activation guard", async () => {
  const mock = mockDb([[[position(1).id, position(1).at]]]);
  await readAlertPage(mock.db as any, "activeJobs", {}, activation, true);
  assert.match(mock.statements[0].text, /'pending', 'submission_unknown'/);
  assert.match(mock.statements[0].text, /exists.*pq_print_attempts/s);
  assert.match(mock.statements[0].text, /finished_at/);
  const job: AlertJob = { id: "j", runId: "r", docType: "workorder", visualId: null, hubPoNumber: null,
    status: "pending", errorMessage: null, retryPhase: "submitting", nextRetryAt: null,
    leaseUntil: new Date("2026-10-02T00:01:00Z"), createdAt: activation, printnodeJobId: null };
  assert.equal(jobAlertEvents(job, [], undefined, activation, new Date("2026-10-02T00:00:00Z")).length, 0);
  assert.ok(jobAlertEvents(job, [], undefined, activation, new Date("2026-10-02T00:02:00Z")).some(e => e.kind === "acceptance_unknown"));
});
test("every source is bounded; reconciliation cycles freeze the upper bound and reset only at the end", async () => {
  for (const stream of ["attemptStarted", "attemptFinished", "activeRuns"] as const) {
    const mock = mockDb([[]]);
    const cursor = { after: position(1), through: "2026-10-03T00:00:00Z" };
    const page = await readAlertPage(mock.db as any, stream, cursor, activation, true);
    assert.deepEqual(page.next, {});
    assert.match(mock.statements[0].text, /limit/);
    assert.ok(mock.statements[0].values.includes(cursor.through));
  }
});
test("production collector takes durable locks and leaves printing untouched", async () => {
  // Empty ledger and source pages: inspect all ten bounded lane transactions.
  // Cursor row replies use table column order: key, cursor, updated_at.
  // Use a fluent outer facade for activation; real Drizzle for transactions.
  const replies: unknown[][][] = [];
  for (let i = 0; i < 10; i++) replies.push([], [["lane", {}, new Date().toISOString()]], [], [], []);
  const mock = mockDb(replies);
  const outer = {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    select: () => ({ from: () => ({ where: async () => [{ value: { since: activation.toISOString() } }] }) }),
    transaction: mock.db.transaction.bind(mock.db),
  };
  const errors: unknown[] = [];
  await collectAutoPrintAlerts({ error: (e: unknown) => errors.push(e) } as any, outer as any);
  assert.equal(errors.length, 0);
  assert.equal(mock.statements.filter(s => /for update skip locked/.test(s.text)).length, 10);
  assert.equal(mock.statements.filter(s => s.text === "commit").length, 10);
  assert.ok(!mock.statements.some(s => /^(update|insert into) "pq_print_/.test(s.text)));
});

test("production delivery error rolls back without checkpointing and later lanes continue", async () => {
  const statements: string[] = [];
  const p = position(1);
  let runQueries = 0;
  const client = { query: async (query: string | { text: string }, _values: unknown[]) => {
    const text = typeof query === "string" ? query : query.text;
    statements.push(text);
    if (/from "pq_admin_alert_cursors"/.test(text)) return { rows: [["lane", {}, activation.toISOString()]] };
    if (/^select .* from "pq_print_runs" where/.test(text)) {
      runQueries++;
      if (/::text/.test(text)) return { rows: [[p.id, p.at]] };
      // Table order: id, trigger, dryRun, status, summary, started, finished, created, updated
      return { rows: [[p.id, "manual", false, "failed", { error: "failure" },
        p.at, p.at, p.at, p.at]] };
    }
    if (/insert into "pq_admin_alerts"/.test(text)) throw new Error("delivery failed");
    return { rows: [] };
  }};
  const db = drizzle(client as any);
  const errors: unknown[] = [];
  await collectAutoPrintAlerts({ error: (e: unknown) => errors.push(e) } as any, {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    select: () => ({ from: () => ({ where: async () => [{ value: { since: activation.toISOString() } }] }) }),
    transaction: db.transaction.bind(db),
  } as any);
  assert.equal(errors.length, 3); // runs forward, reconciliation, active
  assert.equal(statements.filter(s => s === "rollback").length, 3);
  assert.equal(statements.filter(s => s === "commit").length, 7);
  assert.equal(statements.filter(s => /update "pq_admin_alert_cursors"/.test(s)).length, 7);
  assert.equal(runQueries, 6);
});
