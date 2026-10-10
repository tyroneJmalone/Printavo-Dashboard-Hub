import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { jobAlertEvents, runAlertEvents, deliverAlertEvents, type AlertJob, type AlertAttempt, type AlertRun } from "../src/lib/printQueue/autoPrint/alertEvents";
import { createAutoPrintNotificationsRouter } from "../src/routes/autoPrintNotifications";

const since = new Date("2026-10-01T00:00:00Z");
const now = new Date("2026-10-02T12:00:00Z");
const job: AlertJob = { id: "job", runId: "run", docType: "workorder", visualId: "22251",
  hubPoNumber: "PO-1", status: "retry_pending", errorMessage: "Printavo 403", retryPhase: "render",
  nextRetryAt: new Date("2026-10-02T12:15:00Z"), leaseUntil: null, createdAt: now, printnodeJobId: null };
const attempt = (outcome: string): AlertAttempt => ({
  outcome, error: "Printavo 403", phase: "render", startedAt: new Date(now.getTime() - 1000), finishedAt: now,
});
const run: AlertRun = { id: "run", dryRun: false, status: "success", summary: {}, startedAt: now, updatedAt: now, finishedAt: now };

test("first failure includes identity, document, reason, next retry and review link", () => {
  const events = jobAlertEvents(job, [attempt("retry_pending")], run, since, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.visualId, "22251");
  assert.equal(events[0].payload.poNumber, "PO-1");
  assert.equal(events[0].payload.nextAttemptAt, job.nextRetryAt!.toISOString());
  assert.match(events[0].payload.title, /automatic retry scheduled/);
  assert.match(events[0].payload.href, /run=run&job=job/);
});
test("quickly recovered failure is retained; held/exhausted escalate separately", () => {
  assert.equal(jobAlertEvents({ ...job, status: "printed", errorMessage: null }, [attempt("retry_pending")], run, since, now)[0].kind, "failure");
  for (const status of ["held", "exhausted", "failed"]) {
    assert.deepEqual(jobAlertEvents({ ...job, status }, [attempt("retry_pending"), attempt(status)], run, since, now).map(e => e.kind), ["failure", "manual_review"]);
  }
});
test("all document types warn about unknown acceptance and never schedule resends", () => {
  for (const docType of ["workorder", "hub_po", "replacement_slip"]) {
    const events = jobAlertEvents({ ...job, docType, status: "submission_unknown" }, [], run, since, now);
    const unknown = events.find(e => e.kind === "acceptance_unknown")!;
    assert.match(unknown.payload.reason, /PrintNode AND the physical printer/);
    assert.equal(unknown.payload.nextAttemptAt, null);
    assert.ok(!events.some(e => e.kind === "manual_review"));
  }
});
test("active PO reservations including old queued slips are not failure notifications", () => {
  assert.deepEqual(jobAlertEvents({ ...job, docType: "replacement_slip", createdAt: since, status: "submission_unknown",
    errorMessage: "Printer acceptance not yet confirmed. Do not automatically resend." }, [], { ...run, status: "running", finishedAt: null }, since, now), []);
  assert.ok(jobAlertEvents({ ...job, docType: "replacement_slip", status: "submission_unknown",
    errorMessage: "PrintNode timed out" }, [], { ...run, status: "running", finishedAt: null }, since, now)
    .some(event => event.kind === "acceptance_unknown"));
  assert.ok(jobAlertEvents({ ...job, status: "pending", retryPhase: "submitting", leaseUntil: new Date(now.getTime() - 1) }, [], run, since, now).some(e => e.kind === "acceptance_unknown"));
});
test("dry runs and pre-activation failures are excluded, new failures of old jobs included", () => {
  assert.deepEqual(jobAlertEvents(job, [attempt("held")], { ...run, dryRun: true }, since, now), []);
  const old = new Date("2026-09-01");
  assert.deepEqual(jobAlertEvents({ ...job, createdAt: old }, [], { ...run, startedAt: old }, since, now), []);
  assert.ok(jobAlertEvents({ ...job, createdAt: old }, [attempt("held")], { ...run, startedAt: old }, since, now).length);
});
test("run-level errors and interrupted runs need no invoice; dry runs excluded", () => {
  for (const summary of [{ error: "Renderer launch failed" }, { interrupted: true }, {}]) {
    const event = runAlertEvents({ ...run, status: "failed", summary }, since)[0];
    assert.equal(event.kind, "run_failure");
    assert.equal(event.jobId, null);
    assert.equal(event.payload.visualId, null);
  }
  assert.deepEqual(runAlertEvents({ ...run, dryRun: true, status: "failed" }, since), []);
});
test("durable-key dedup survives repeated workers/restarts; delivery failure retries safely", async () => {
  const persisted = new Map<string, unknown>();
  const events = jobAlertEvents({ ...job, status: "exhausted" }, [attempt("exhausted")], run, since, now);
  let fail = true, errors = 0;
  const store = async (e: typeof events[number]) => {
    if (fail) { fail = false; throw new Error("DB temporarily unavailable"); }
    if (!persisted.has(e.eventKey)) persisted.set(e.eventKey, structuredClone(e));
  };
  const before = JSON.stringify(job);
  await deliverAlertEvents(events, store, () => errors++);
  await Promise.all([deliverAlertEvents(events, store, () => errors++), deliverAlertEvents(events, store, () => errors++)]);
  await deliverAlertEvents(jobAlertEvents({ ...job, status: "exhausted" }, [attempt("exhausted")], run, since, now), store, () => errors++);
  assert.equal(errors, 1);
  assert.equal(persisted.size, 2);
  assert.equal(JSON.stringify(job), before);
});

test("abandoned discovery run alerts without jobs or a subsequent run; fresh heartbeat suppresses false alerts", () => {
  const running = { ...run, status: "running", summary: {}, finishedAt: null,
    startedAt: new Date(now.getTime() - 6 * 60 * 60_000), updatedAt: new Date(now.getTime() - 121_000) };
  const events = runAlertEvents(running, since, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].jobId, null);
  assert.match(events[0].payload.reason, /heartbeat/);
  assert.equal(events[0].payload.retryState, "heartbeat_lost_review_required");
  assert.deepEqual(runAlertEvents({ ...running, updatedAt: new Date(now.getTime() - 30_000) }, since, now), []);
  assert.deepEqual(runAlertEvents({ ...running, updatedAt: now }, since, now), []);
  assert.deepEqual(runAlertEvents({ ...running, dryRun: true }, since, now), []);
  assert.deepEqual(runAlertEvents({ ...running, startedAt: new Date("2026-09-01") }, since, now), []);
  assert.equal(runAlertEvents(running, since, new Date(now.getTime() + 60_000))[0].eventKey, events[0].eventKey);
});
test("only admins can receive/read alerts; acknowledgement identity cannot be spoofed; delivery errors isolated", async () => {
  const calls: string[] = [];
  let unavailable = false;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-role"]) req.staff = { role: String(req.headers["x-role"]), email: "admin@example.test" } as any;
    next();
  });
  app.use(createAutoPrintNotificationsRouter({
    list: async email => { calls.push(email); if (unavailable) throw new Error("Unavailable"); return { items: [], total: 0, unread: 0 }; },
    read: async email => { calls.push(email); return true; },
  }));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "Unavailable" }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/print-queue/auto-print/notifications`;
  try {
    for (const role of ["staff", "manager", ""]) {
      const headers = role ? { "x-role": role } : {};
      assert.equal((await fetch(base, { headers })).status, 403);
      assert.equal((await fetch(base + "/00000000-0000-4000-8000-000000000001/read", { method: "POST", headers })).status, 403);
    }
    assert.equal(calls.length, 0);
    const headers = { "x-role": "admin", "content-type": "application/json" };
    assert.equal((await fetch(base, { headers })).status, 200);
    assert.equal((await fetch(base + "/00000000-0000-4000-8000-000000000001/read", { method: "POST", headers, body: JSON.stringify({ email: "other@example.test" }) })).status, 204);
    assert.deepEqual(calls, ["admin@example.test", "admin@example.test"]);
    unavailable = true;
    assert.equal((await fetch(base, { headers })).status, 500);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
