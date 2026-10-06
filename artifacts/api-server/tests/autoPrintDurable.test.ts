import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, pool, pqPrintJobsTable as jobs, pqPrintAttemptsTable as attempts, appSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { enqueuePrint, claimPrint, fencePrint, finishPrint, recoverPrintLeases, changeRetryState } from "../src/lib/printQueue/autoPrint/retryStore";
import { executePrintAttempt, finalizePrintAttempt, liveRetryDependencies, type RetryDependencies } from "../src/lib/printQueue/autoPrint/retryWorker";
import { prepareRetry } from "../src/lib/printQueue/autoPrint/retryPreparation";
import { applyRetryAction } from "../src/lib/printQueue/autoPrint/retryAdmin";
import { failureStatusEligible } from "../src/lib/printQueue/autoPrint/retryEligibility";
import { isWorkorder403, nextForbiddenRetry } from "../src/lib/printQueue/autoPrint/forbiddenRetry";

test("403 policy is render-only and caps both rounds, with a cooldown after attempt three", () => {
  assert.equal(isWorkorder403(new Error("Printavo returned 403"), "render"), true);
  for (const phase of ["live_detail", "verification", "submission", "persistence"]) {
    assert.equal(isWorkorder403(new Error("Printavo returned 403"), phase), false);
  }
  assert.equal(isWorkorder403(new Error("PrintNode returned 403"), "render"), false);
  let state: ReturnType<typeof nextForbiddenRetry> | undefined;
  const delays = [];
  for (let n = 0; n < 7; n++) { state = nextForbiddenRetry(state); delays.push(state.delayMs); }
  assert.deepEqual(delays, [1000, 2000, 900000, 1000, 2000, null, null]);
});

test("durable queue: isolated DB claims, leases, dedup and injected delivery failures", async () => {
  const schema = `retry_test_${randomUUID().replaceAll("-", "")}`;
  // Isolated schema, UUID defaults only. No production rows or sequence defaults.
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const client = await pool.connect();
  await client.query(`CREATE TABLE "${schema}".pq_print_jobs (LIKE public.pq_print_jobs INCLUDING ALL);
    CREATE TABLE "${schema}".pq_print_attempts (LIKE public.pq_print_attempts INCLUDING ALL);
    CREATE TABLE "${schema}".app_settings (LIKE public.app_settings INCLUDING ALL);
    CREATE TABLE "${schema}".pv_orders (LIKE public.pv_orders INCLUDING ALL);
    CREATE TABLE "${schema}".change_events (LIKE public.change_events INCLUDING ALL);
    CREATE TABLE "${schema}".pq_print_runs (LIKE public.pq_print_runs INCLUDING ALL)`);
  await client.query(`SET search_path TO "${schema}"`);
  client.release();
  const onConnect = (c: any) => { void c.query(`SET search_path TO "${schema}"`); };
  pool.on("connect", onConnect);
  let sends = 0, reads = 0;
  const snapshot = { orderKind: "invoice" as const, delaysMinutes: [2, 10, 30], errorStatusId: "error" };
  const make = async (visual = String(Math.floor(Math.random() * 100000000))) => {
    const job = await enqueuePrint({ runId: randomUUID(), printavoOrderId: `fixture-${visual}`,
      visualId: visual, status: "pending", sourceStatusId: "source", printerId: "123" }, snapshot);
    assert.ok(job); return job;
  };
  const node = (job: any) => ({ id: job.printavoOrderId, visualId: Number(job.visualId),
    workorderUrl: "https://www.printavo.com/fixture", lineItemGroups: { pageInfo: { hasNextPage: false }, nodes: [] } });
  const dependencies = (job: any): RetryDependencies => ({
    claim: claimPrint, fence: fencePrint, finish: finishPrint,
    status: async () => { reads++; return { orderId: job.printavoOrderId, visualId: Number(job.visualId), statusId: "source", statusName: "Source" }; },
    detail: async () => ({ invoice: node(job) } as any),
    render: async () => Buffer.from("mock-pdf"), configured: () => true,
    submit: async () => { sends++; return 1234; },
    prepare: async j => j,
  });
  try {
    const priorVisual = "999992";
    const [prior] = await db.insert(jobs).values({ runId: randomUUID(), printavoOrderId: `fixture-${priorVisual}`,
      visualId: priorVisual, status: "printed", printedAt: new Date(), contentFingerprint: "baseline" }).returning();
    const priorFailure = await enqueuePrint({ runId: randomUUID(), printavoOrderId: prior.printavoOrderId,
      visualId: priorVisual, priorJobId: prior.id, status: "failed", errorMessage: "detail timeout", retryCount: 1,
      retryPhase: "live_detail", sourceStatusId: "source", printerId: "123" }, { ...snapshot, delaysMinutes: [] });
    assert.equal(priorFailure?.status, "held", "disabled retries hold preparatory prior-print failures");
    assert.equal(failureStatusEligible(priorFailure!), false);
    const noPriorFailure = await enqueuePrint({ runId: randomUUID(), printavoOrderId: "fixture-new-failure",
      visualId: "999993", status: "failed", errorMessage: "detail timeout", retryCount: 1,
      retryPhase: "live_detail", sourceStatusId: "source", printerId: "123" }, { ...snapshot, delaysMinutes: [] });
    assert.equal(noPriorFailure?.status, "exhausted");
    assert.equal(failureStatusEligible(noPriorFailure!), true);
    await changeRetryState(priorFailure!.id, "retry", "fixture");
    const priorDeps = dependencies(priorFailure);
    priorDeps.detail = async () => { throw new Error("detail timeout"); };
    const priorExhausted = await executePrintAttempt(priorFailure!.id, "fixture", priorDeps);
    assert.equal(priorExhausted?.status, "held", "repeated exhaustion cannot authorize failure transition");
    assert.equal(failureStatusEligible(priorExhausted!), false);
    assert.equal(failureStatusEligible({ ...priorFailure!, eligibilityCycle: "entry:1", contentFingerprint: "new",
      snapshotMetadata: { durableRetry: { fingerprint: "new" } } }), true, "established reprint eligibility permits terminal status handling");
    const one = await make("999991");
    const duplicate = await enqueuePrint({ ...one, id: undefined, printavoOrderId: "converted-invoice" }, snapshot);
    assert.equal(duplicate, null, "visual identity dedup survives quote conversion");
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimPrint(one.id, "fixture")));
    assert.equal(claims.filter(Boolean).length, 1, "single transactional winner");
    const claimed = claims.find(Boolean)!;
    await db.update(jobs).set({ leaseUntil: new Date(0) }).where(eq(jobs.id, one.id));
    await recoverPrintLeases();
    await assert.rejects(fencePrint(claimed, "submitting"), /lease lost/);
    assert.equal((await db.select().from(jobs).where(eq(jobs.id, one.id)))[0].status, "retry_pending");
    const reclaimed = (await claimPrint(one.id, "fixture"))!;
    await fencePrint(reclaimed, "submitting");
    await db.update(jobs).set({ leaseUntil: new Date(0) }).where(eq(jobs.id, one.id));
    await recoverPrintLeases();
    assert.equal((await db.select().from(jobs).where(eq(jobs.id, one.id)))[0].status, "submission_unknown");
    await assert.rejects(changeRetryState(one.id, "retry", "fixture"));
    const renderJob = await make();
    const renderDeps = dependencies(renderJob);
    renderDeps.render = async () => { throw new Error("Printavo returned 403"); };
    let outcome = await executePrintAttempt(renderJob.id, "fixture", renderDeps);
    assert.equal(outcome?.status, "retry_pending"); assert.equal(sends, 0);
    assert.equal(outcome?.retryCount, 3, "first round performs exactly three attempts");
    assert.match(outcome!.errorMessage!, /round 1 exhausted; waiting 15 minutes/);
    assert.ok(outcome!.nextRetryAt!.getTime() > Date.now() + 895000);
    assert.ok(outcome!.nextRetryAt!.getTime() <= Date.now() + 900000);
    assert.equal(await executePrintAttempt(renderJob.id, "fixture", renderDeps), null, "not yet due");
    const advances: unknown[] = [];
    const finalizationDeps = { status: renderDeps.status,
      po: async () => ({ printed: 0, failed: 0, unknown: 0, warnings: [] }),
      advance: (async (...args: unknown[]) => { advances.push(args); return { status: "started", job: {} }; }) as any };
    const quiet: any = { warn() {}, error() {}, info() {} };
    await finalizePrintAttempt(outcome!, quiet, finalizationDeps);
    assert.equal(advances.length, 0, "Print Error is withheld during cooldown");
    // Simulate passage of the persisted cooldown, not an operator override.
    await db.update(jobs).set({ nextRetryAt: new Date(0) }).where(eq(jobs.id, renderJob.id));
    outcome = await executePrintAttempt(renderJob.id, "fixture", renderDeps);
    assert.equal(outcome?.status, "exhausted");
    assert.equal(outcome?.retryCount, 6);
    await finalizePrintAttempt(outcome!, quiet, finalizationDeps);
    assert.equal(advances.length, 1, "failure status is requested only after final round");
    assert.equal(await executePrintAttempt(renderJob.id, "fixture", renderDeps), null);
    const history = await db.select().from(attempts).where(eq(attempts.jobId, renderJob.id));
    assert.equal(history.filter(a => a.phase === "render").length, 6);
    const moved = await make();
    const movedDeps = dependencies(moved);
    movedDeps.status = async () => ({ orderId: moved.printavoOrderId, visualId: Number(moved.visualId), statusId: "other", statusName: "Other" });
    assert.equal((await executePrintAttempt(moved.id, "fixture", movedDeps))?.status, "held");
    assert.equal(sends, 0);
    const timeout = await make();
    const timeoutDeps = dependencies(timeout);
    timeoutDeps.submit = async () => { sends++; throw new Error("ECONNRESET"); };
    assert.equal((await executePrintAttempt(timeout.id, "fixture", timeoutDeps))?.status, "submission_unknown");
    assert.equal(await executePrintAttempt(timeout.id, "fixture", timeoutDeps), null);
    const accepted = await make();
    assert.equal((await executePrintAttempt(accepted.id, "fixture", dependencies(accepted)))?.status, "printed");
    await assert.rejects(changeRetryState(accepted.id, "retry", "fixture"));
    assert.equal(sends, 2);
    assert.ok(reads >= 6);
    const lateMove = await make();
    const lateDeps = dependencies(lateMove);
    let statusReads = 0;
    lateDeps.status = async () => ({ orderId: lateMove.printavoOrderId, visualId: Number(lateMove.visualId),
      statusId: ++statusReads === 1 ? "source" : "other", statusName: "status" });
    assert.equal((await executePrintAttempt(lateMove.id, "fixture", lateDeps))?.status, "held");
    assert.equal(sends, 2, "post-render move never submits");
    const persistence = await make();
    const persistenceDeps = dependencies(persistence);
    let finishes = 0;
    persistenceDeps.finish = async (j, patch) => {
      if (++finishes === 1) throw new Error("database disconnected after accepted POST");
      return finishPrint(j, patch);
    };
    const saved = await executePrintAttempt(persistence.id, "fixture", persistenceDeps);
    assert.equal(saved?.status, "printed");
    assert.equal(saved?.printnodeJobId, "1234");
    assert.equal(sends, 3, "persistence failure never submits again");
    const cancelled = await make();
    await changeRetryState(cancelled.id, "cancel", "fixture");
    assert.equal(await executePrintAttempt(cancelled.id, "fixture", dependencies(cancelled)), null);
    assert.equal(await enqueuePrint({ ...cancelled, id: undefined }, snapshot), null);
    await db.insert(appSettingsTable).values({ key: "pq_autoprint_config", value: {
      categoryMappings: [
        { category: "Screen Printing", statusId: "print-destination", statusName: "Print" },
        { category: "Embroidery", statusId: "embroidery-destination", statusName: "Embroidery" },
      ],
    } });
    const log: any = { warn() {}, error() {}, info() {} };
    const originalStatus = liveRetryDependencies.status, originalDetail = liveRetryDependencies.detail;
    try {
      for (const [oldDestination, category, expected] of [
        [null, "Screen Printing", "print-destination"],
        ["print-destination", "Embroidery", "embroidery-destination"],
      ] as const) {
        const recovering = await make();
        await changeRetryState(recovering.id, "cancel", "fixture");
        await db.update(jobs).set({ targetStatusId: oldDestination }).where(eq(jobs.id, recovering.id));
        const detail: any = { ...node(recovering), lineItemGroups: { pageInfo: { hasNextPage: false },
          nodes: [{ lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "line", items: 5, category: { name: category } }] } }] } };
        const deps = dependencies(recovering);
        deps.detail = async () => ({ invoice: detail });
        deps.prepare = prepareRetry; // Exercise actual preparation, not a substitute.
        liveRetryDependencies.status = deps.status;
        liveRetryDependencies.detail = deps.detail;
        const before = sends;
        await applyRetryAction(recovering.id, { action: "recover", expectedStatusId: "source",
          confirmedNotSubmitted: true, note: "Offline fixture review" }, "fixture", log);
        assert.equal(sends, before, "staging recovery never submits");
        await changeRetryState(recovering.id, "retry", "fixture");
        const result = await executePrintAttempt(recovering.id, "fixture", deps);
        assert.equal(result?.status, "printed");
        assert.equal(result?.targetStatusId, expected);
        const advances: any[] = [];
        await finalizePrintAttempt(result!, log, {
          status: deps.status,
          po: async () => ({ printed: 0, failed: 0, unknown: 0, warnings: [] }),
          advance: (async (_trigger: unknown, lines: unknown) => { advances.push(lines); return { status: "started", job: {} }; }) as any,
        });
        assert.equal(advances[0][0].targetStatusId, expected, "accepted recovered print uses reviewed decoration destination");
        assert.equal(await executePrintAttempt(recovering.id, "fixture", deps), null);
        assert.equal(sends, before + 1, "one workorder despite recovery and finalization");
      }
    } finally {
      liveRetryDependencies.status = originalStatus;
      liveRetryDependencies.detail = originalDetail;
    }
    const recoverable = await make();
    const recoverDeps = dependencies(recoverable);
    const beforeRecovery = sends;
    recoverDeps.render = async () => { throw new Error("Printavo returned 403"); };
    const waiting = await executePrintAttempt(recoverable.id, "fixture", recoverDeps);
    assert.equal(waiting?.retryCount, 3);
    // Recovery after the cooldown succeeds exactly once without a new run/job.
    recoverDeps.render = async () => Buffer.from("recovered");
    await db.update(jobs).set({ nextRetryAt: new Date(0) }).where(eq(jobs.id, recoverable.id));
    assert.equal((await executePrintAttempt(recoverable.id, "fixture", recoverDeps))?.status, "printed");
    assert.equal(sends, beforeRecovery + 1);
    assert.equal(await executePrintAttempt(recoverable.id, "fixture", recoverDeps), null);

    const manual = await make();
    await changeRetryState(manual.id, "retry", "fixture");
    const manualDeps = dependencies(manual);
    manualDeps.render = async () => { throw new Error("Printavo returned 403"); };
    const manualResult = await executePrintAttempt(manual.id, "fixture", manualDeps);
    assert.equal(manualResult?.retryCount, 1, "manual override remains one attempt");
    assert.equal(manualResult?.status, "exhausted");

    const interrupted = await make();
    await db.update(jobs).set({ snapshotMetadata: { durableRetry: { ...snapshot,
      forbiddenRetry: { failures: 2, delayMs: 2000 } } } }).where(eq(jobs.id, interrupted.id));
    const interruptedClaim = await claimPrint(interrupted.id, "fixture");
    await fencePrint(interruptedClaim!, "render");
    await db.update(jobs).set({ leaseUntil: new Date(0) }).where(eq(jobs.id, interrupted.id));
    await recoverPrintLeases();
    const [afterCrash] = await db.select().from(jobs).where(eq(jobs.id, interrupted.id));
    assert.equal(afterCrash.status, "retry_pending");
    assert.ok(afterCrash.nextRetryAt!.getTime() > Date.now() + 895000, "lease recovery preserves round cooldown");
    for (const scenario of ["moved", "uncertain"] as const) {
      const staged = await make();
      await db.update(jobs).set({ snapshotMetadata: { durableRetry: { ...snapshot,
        forbiddenRetry: { failures: 3, delayMs: 900000 } } } }).where(eq(jobs.id, staged.id));
      const deps = dependencies(staged);
      const before = sends;
      if (scenario === "moved") {
        deps.status = async () => ({ orderId: staged.printavoOrderId, visualId: Number(staged.visualId), statusId: "other", statusName: "Other" });
      } else {
        deps.submit = async () => { sends++; throw new Error("timeout after POST"); };
      }
      const result = await executePrintAttempt(staged.id, "fixture", deps);
      assert.equal(result?.status, scenario === "moved" ? "held" : "submission_unknown");
      assert.equal(sends, before + (scenario === "uncertain" ? 1 : 0));
      assert.equal(await executePrintAttempt(staged.id, "fixture", deps), null, "second-round safety outcome is never resent");
    }
  } finally {
    pool.off("connect", onConnect);
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
