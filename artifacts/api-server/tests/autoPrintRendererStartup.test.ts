import assert from "node:assert/strict";
import test from "node:test";
import {
  AutoPrintRendererStartupError,
  PDF_RENDERER_STARTUP_ERROR_PREFIX,
  withRendererStartupGuard,
} from "../src/lib/printQueue/autoPrint/rendererStartupGuard.ts";

test("renderer startup exhaustion records every pending document once and performs no work", async () => {
  const pending = [{ id: "one" }, { id: "two" }, { id: "three" }];
  const recorded: { id: string; error: string }[] = [];
  let submitCalls = 0;
  let statusCalls = 0;

  await assert.rejects(
    withRendererStartupGuard(
      pending,
      async () => {
        throw new Error("Chromium unavailable after 3 attempts");
      },
      async (documents, message) => {
        for (const document of documents) {
          recorded.push({ id: document.id, error: message });
        }
      },
      async () => {
        submitCalls += 1;
        statusCalls += 1;
      },
    ),
    (error: unknown) =>
      error instanceof AutoPrintRendererStartupError &&
      error.message ===
        `${PDF_RENDERER_STARTUP_ERROR_PREFIX}Chromium unavailable after 3 attempts`,
  );

  assert.deepEqual(
    recorded.map((row) => row.id),
    ["one", "two", "three"],
  );
  assert.equal(new Set(recorded.map((row) => row.id)).size, pending.length);
  assert.ok(
    recorded.every((row) =>
      row.error.startsWith(PDF_RENDERER_STARTUP_ERROR_PREFIX),
    ),
  );
  assert.equal(submitCalls, 0);
  assert.equal(statusCalls, 0);
});

test("successful renderer startup creates no failure records or duplicate work", async () => {
  const pending = [{ id: "one" }, { id: "two" }];
  const worked: string[] = [];
  let failureRecordCalls = 0;
  let closeCalls = 0;

  await withRendererStartupGuard(
    pending,
    async () => ({
      async renderUrl() {
        return Buffer.from("pdf");
      },
      async close() {
        closeCalls += 1;
      },
    }),
    async () => {
      failureRecordCalls += 1;
    },
    async (_renderer, documents) => {
      for (const document of documents) worked.push(document.id);
    },
  );

  assert.deepEqual(worked, ["one", "two"]);
  assert.equal(failureRecordCalls, 0);
  assert.equal(closeCalls, 1);
});