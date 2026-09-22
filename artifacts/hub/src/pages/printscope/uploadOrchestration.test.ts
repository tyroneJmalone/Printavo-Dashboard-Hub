import test from "node:test";
import assert from "node:assert/strict";
import {
  nextPendingUpload,
  runUploadAttempt,
  type UploadAttemptDependencies,
  type UploadItem
} from "./uploadOrchestration.ts";

function pendingItem(): UploadItem {
  return {
    id: "local-1",
    filename: "art.ai",
    byteSize: 3,
    contentType: "application/pdf",
    status: "pending",
    resumeAt: "reserve",
    file: new File(["pdf"], "art.ai", { type: "application/pdf" }),
    retryable: true
  };
}

test("PUT failure retry reuses the known reservation and job ID", async () => {
  let reserveCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  const dependencies: UploadAttemptDependencies = {
    reserve: async () => {
      reserveCalls += 1;
      return { job: { id: "job-put", state: "uploading" }, uploadURL: "/signed/job-put" };
    },
    put: async () => {
      putCalls += 1;
      return { ok: putCalls > 1, status: putCalls > 1 ? 200 : 503 };
    },
    getJob: async id => ({ id, state: "uploading" }),
    complete: async id => {
      completeCalls += 1;
      return { id, state: "queued" };
    }
  };

  const failed = await runUploadAttempt(pendingItem(), dependencies);
  assert.equal(failed.status, "error");
  assert.equal(failed.resumeAt, "upload");
  assert.equal(failed.jobId, "job-put");

  const retried = await runUploadAttempt({ ...failed, status: "pending" }, dependencies);
  assert.equal(retried.status, "queued");
  assert.equal(retried.jobId, "job-put");
  assert.equal(reserveCalls, 1);
  assert.equal(putCalls, 2);
  assert.equal(completeCalls, 1);
});

test("completion failure retry reuses job ID without repeating reserve or PUT", async () => {
  let reserveCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  const dependencies: UploadAttemptDependencies = {
    reserve: async () => {
      reserveCalls += 1;
      return { job: { id: "job-complete", state: "uploading" }, uploadURL: "/signed/job-complete" };
    },
    put: async () => {
      putCalls += 1;
      return { ok: true, status: 200 };
    },
    getJob: async id => ({ id, state: "uploading" }),
    complete: async id => {
      completeCalls += 1;
      if (completeCalls === 1) throw new Error("response lost");
      return { id, state: "queued" };
    }
  };

  const failed = await runUploadAttempt(pendingItem(), dependencies);
  assert.equal(failed.status, "error");
  assert.equal(failed.resumeAt, "complete");
  assert.equal(failed.jobId, "job-complete");
  assert.equal(failed.file, undefined);

  const retried = await runUploadAttempt({ ...failed, status: "pending" }, dependencies);
  assert.equal(retried.status, "queued");
  assert.equal(retried.jobId, "job-complete");
  assert.equal(reserveCalls, 1);
  assert.equal(putCalls, 1);
  assert.equal(completeCalls, 2);
});

test("queued items are excluded from pending work and are a no-op", async () => {
  const completed: UploadItem = {
    ...pendingItem(),
    status: "queued",
    resumeAt: "complete",
    jobId: "job-done",
    file: undefined,
    retryable: false
  };
  let calls = 0;
  const dependencies: UploadAttemptDependencies = {
    reserve: async () => { calls += 1; throw new Error("unexpected"); },
    put: async () => { calls += 1; return { ok: true, status: 200 }; },
    getJob: async () => { calls += 1; return { state: "completed" }; },
    complete: async () => { calls += 1; return { state: "completed" }; }
  };

  assert.equal(nextPendingUpload([completed]), undefined);
  assert.equal(await runUploadAttempt(completed, dependencies), completed);
  assert.equal(calls, 0);
});

test("lost completion response is recovered from job state without completing twice", async () => {
  let serverState = "uploading";
  let completeCalls = 0;
  const dependencies: UploadAttemptDependencies = {
    reserve: async () => ({
      job: { id: "job-ack-lost", state: "uploading" },
      uploadURL: "/signed/job-ack-lost"
    }),
    put: async () => ({ ok: true, status: 200 }),
    getJob: async id => ({ id, state: serverState }),
    complete: async () => {
      completeCalls += 1;
      serverState = "queued";
      throw new Error("completion response lost");
    }
  };

  const failed = await runUploadAttempt(pendingItem(), dependencies);
  assert.equal(failed.status, "error");
  assert.equal(failed.jobId, "job-ack-lost");

  const recovered = await runUploadAttempt({ ...failed, status: "pending" }, dependencies);
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.jobId, "job-ack-lost");
  assert.equal(completeCalls, 1);
});