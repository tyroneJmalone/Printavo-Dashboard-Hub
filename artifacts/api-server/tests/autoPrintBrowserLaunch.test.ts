import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_STARTUP_BACKOFF_MS,
  BROWSER_STARTUP_MAX_ATTEMPTS,
  BROWSER_STARTUP_TIMEOUT_MS,
  BrowserStartupError,
  classifyBrowserStartupError,
  launchBrowserWithRecovery,
  type LaunchableBrowser,
} from "../src/lib/printQueue/autoPrint/browserLaunch";

test("production startup budget retains three 30 second attempts", () => {
  assert.equal(BROWSER_STARTUP_TIMEOUT_MS, 30_000);
  assert.equal(BROWSER_STARTUP_MAX_ATTEMPTS, 3);
  assert.deepEqual(BROWSER_STARTUP_BACKOFF_MS, [500, 1_000]);
});

function browser(onClose?: () => void, onKill?: () => void): LaunchableBrowser {
  return {
    async close() {
      onClose?.();
    },
    process() {
      return { kill: () => (onKill?.(), true) };
    },
  };
}

function logger() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    info(fields: Record<string, unknown>) {
      entries.push(fields);
    },
    warn(fields: Record<string, unknown>) {
      entries.push(fields);
    },
  };
}

test("recovers after bounded launch failures", async () => {
  let attempts = 0;
  const log = logger();
  const expected = browser();
  const actual = await launchBrowserWithRecovery({
    logger: log,
    timeoutMs: 20,
    backoffMs: [0, 0],
    sleep: async () => undefined,
    launch: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Failed to launch browser process");
      return expected;
    },
  });

  assert.equal(actual, expected);
  assert.equal(attempts, 3);
  assert.deepEqual(
    log.entries.map(({ attempt, reason }) => ({ attempt, reason })),
    [
      { attempt: 1, reason: "process_crashed" },
      { attempt: 2, reason: "process_crashed" },
      { attempt: 3, reason: undefined },
    ],
  );
});

test("exhaustion returns only a safe classified reason", async () => {
  const secret = "https://customer.example/workorder?token=do-not-log";
  const log = logger();
  await assert.rejects(
    launchBrowserWithRecovery({
      logger: log,
      timeoutMs: 20,
      backoffMs: [0, 0],
      sleep: async () => undefined,
      launch: async () => {
        throw new Error(`ENOENT ${secret}`);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserStartupError);
      assert.equal(error.reason, "executable_not_found");
      assert.equal(error.attempts, 3);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
  assert.equal(log.entries.length, 3);
  assert.ok(!JSON.stringify(log.entries).includes(secret));
});

test("a browser resolving after timeout is closed and killed", async () => {
  let closes = 0;
  let kills = 0;
  let resolveLaunch!: (value: LaunchableBrowser) => void;
  const pending = new Promise<LaunchableBrowser>((resolve) => {
    resolveLaunch = resolve;
  });

  const result = launchBrowserWithRecovery({
    logger: logger(),
    timeoutMs: 5,
    maxAttempts: 1,
    closeTimeoutMs: 5,
    launch: async () => pending,
  });
  await assert.rejects(result, BrowserStartupError);
  resolveLaunch(browser(() => closes += 1, () => kills += 1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closes, 1);
  assert.equal(kills, 1);
});

test("startup diagnostics use a finite safe classification", () => {
  assert.equal(
    classifyBrowserStartupError(
      new Error("error while loading shared libraries: libnss3.so"),
    ),
    "missing_library",
  );
  assert.equal(
    classifyBrowserStartupError(
      new Error(
        "error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory",
      ),
    ),
    "missing_library",
  );
  assert.equal(classifyBrowserStartupError({ private: "value" }), "unknown");
});