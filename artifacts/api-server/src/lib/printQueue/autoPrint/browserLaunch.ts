/**
 * Bounded Chromium startup policy.
 *
 * Limits: three 30s attempts, with 500ms then 1s backoff (91.5s before
 * cleanup overhead). A browser returned after an attempt times out is closed,
 * and its process is SIGKILLed if graceful close takes more than 2s.
 *
 * With pipe transport Puppeteer's `timeout` does not gate pipe connection
 * creation (it is only forwarded to the Connection). This helper's watchdog
 * is the effective startup bound. Aborting its signal synchronously invokes
 * @puppeteer/browsers Process.kill(), which SIGKILLs Chromium's process group
 * (falling back to the direct child PID), so retries do not accumulate orphan
 * processes before Puppeteer returns a Browser. A late-returned Browser is
 * also closed here. The remaining gap is an OS-level kill failure (for example
 * an uninterruptible process or denied permission): before Browser is returned
 * Puppeteer alone owns the PID, so this helper cannot independently retry the
 * kill without replacing Puppeteer's launcher.
 *
 * Chromium stderr is only available
 * indirectly in Puppeteer's thrown error. We classify that text into a fixed
 * reason and never log or rethrow the raw text, since it can contain command
 * lines, URLs, tokens, or customer filesystem paths.
 */

export const BROWSER_STARTUP_TIMEOUT_MS = 30_000;
export const BROWSER_STARTUP_MAX_ATTEMPTS = 3;
export const BROWSER_STARTUP_BACKOFF_MS = [500, 1_000] as const;
export const BROWSER_CLOSE_TIMEOUT_MS = 2_000;

export type BrowserStartupReason =
  | "timeout"
  | "executable_not_found"
  | "permission_denied"
  | "missing_library"
  | "sandbox_failure"
  | "profile_locked"
  | "resource_exhausted"
  | "protocol_failure"
  | "process_crashed"
  | "unknown";

export interface LaunchableBrowser {
  close(): Promise<void>;
  process(): { kill(signal?: NodeJS.Signals | number): boolean } | null;
}

interface SafeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface BrowserLaunchAttemptOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

export interface BrowserLaunchRecoveryOptions<T extends LaunchableBrowser> {
  launch(options: BrowserLaunchAttemptOptions): Promise<T>;
  logger: SafeLogger;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  closeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class BrowserStartupError extends Error {
  readonly reason: BrowserStartupReason;
  readonly attempts: number;

  constructor(reason: BrowserStartupReason, attempts: number) {
    super(`Chromium startup failed (${reason}) after ${attempts} attempts`);
    this.name = "BrowserStartupError";
    this.reason = reason;
    this.attempts = attempts;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  return typeof error === "string" ? error.toLowerCase() : "";
}

export function classifyBrowserStartupError(
  error: unknown,
): BrowserStartupReason {
  const text = errorText(error);
  if (/timed out|timeout|aborterror|aborted/.test(text)) return "timeout";
  if (/shared librar|cannot open shared object|error while loading/.test(text)) {
    return "missing_library";
  }
  if (/enoent|not found|no such file|browser was not found/.test(text)) {
    return "executable_not_found";
  }
  if (/eacces|permission denied/.test(text)) return "permission_denied";
  if (/no usable sandbox|sandbox.*failed|zygote_host_impl/.test(text)) {
    return "sandbox_failure";
  }
  if (/processsingleton|profile.*(lock|in use)|already running/.test(text)) {
    return "profile_locked";
  }
  if (/enomem|out of memory|resource temporarily unavailable|cannot allocate/.test(text)) {
    return "resource_exhausted";
  }
  if (/protocol|target closed|connection closed|session closed/.test(text)) {
    return "protocol_failure";
  }
  if (/failed to launch|process.*(crash|exit)|browser.*(crash|closed)/.test(text)) {
    return "process_crashed";
  }
  return "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closeBrowserBounded(
  browser: LaunchableBrowser,
  timeoutMs = BROWSER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // close() can resolve before process exit, and can also hang. kill() is
  // harmless when the process has already exited.
  try {
    browser.process()?.kill("SIGKILL");
  } catch {
    // Best effort after bounded graceful cleanup.
  }
}

export async function launchBrowserWithRecovery<T extends LaunchableBrowser>(
  options: BrowserLaunchRecoveryOptions<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? BROWSER_STARTUP_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? BROWSER_STARTUP_MAX_ATTEMPTS;
  const backoffs = options.backoffMs ?? BROWSER_STARTUP_BACKOFF_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  let lastReason: BrowserStartupReason = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const launchPromise = options
      .launch({ signal: controller.signal, timeoutMs })
      .then(async (browser) => {
        if (timedOut) {
          await closeBrowserBounded(browser, closeTimeoutMs);
          throw new Error("Chromium startup timed out");
        }
        return browser;
      });

    // Keep the losing launch promise observed. In particular, a mocked or
    // unexpectedly late Puppeteer resolution must not leak a browser.
    void launchPromise.catch(() => undefined);

    try {
      const browser = await Promise.race([
        launchPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("Chromium startup timed out"));
          }, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (attempt > 1) {
        options.logger.info(
          { attempt, maxAttempts, elapsedMs: Date.now() - startedAt },
          "Chromium startup recovered",
        );
      }
      return browser;
    } catch (error) {
      if (timer) clearTimeout(timer);
      controller.abort();
      lastReason = classifyBrowserStartupError(error);
      options.logger.warn(
        {
          attempt,
          maxAttempts,
          elapsedMs: Date.now() - startedAt,
          reason: lastReason,
        },
        "Chromium startup attempt failed",
      );
      if (attempt < maxAttempts) {
        await sleep(backoffs[attempt - 1] ?? backoffs.at(-1) ?? 0);
      }
    }
  }

  throw new BrowserStartupError(lastReason, maxAttempts);
}