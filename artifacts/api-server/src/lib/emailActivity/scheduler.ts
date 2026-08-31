import type { Logger } from "pino";
import { runEmailSync, isEmailSyncActive } from "./sync";
import { gmailConfigured } from "./gmail";
import {
  runMissiveSync,
  isMissiveSyncActive,
  isMissiveConnectorReady,
  purgeCorrespondenceRetention,
} from "../missive/sync";
import { claimEmailSyncWriter } from "./writerLock";

/**
 * Email activity sync scheduler — same shape as the catalog scheduler:
 * idempotent start, unref'd interval, guarded async tick. Every tick syncs
 * all active mailboxes (backfill pages first, then incremental history).
 * Dormant when the GOOGLE_SERVICE_ACCOUNT_JSON secret is missing.
 */

const TICK_MS = 10 * 60 * 1000;
const BOOT_DELAY_MS = 20 * 1000;

let started = false;

export function startEmailActivityScheduler(log: Logger): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      // Single-writer rule: when production runs 24/7 it owns the sync;
      // a dev workspace tick stands down instead of double-syncing.
      if (!(await claimEmailSyncWriter(log))) return;
      await purgeCorrespondenceRetention();
      if (gmailConfigured() && !isEmailSyncActive()) {
        const result = await runEmailSync(log);
        if (result.ran) log.info({ result: result.message }, "email activity sync tick done");
      }
      if (!isMissiveSyncActive() && isMissiveConnectorReady()) {
        const result = await runMissiveSync(log);
        if (result.ran) log.info({ result: result.message }, "Missive sync tick done");
      }
    } catch (err) {
      log.error({ err }, "email activity sync tick failed");
    }
  };
  const boot = setTimeout(() => void tick(), BOOT_DELAY_MS);
  boot.unref();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}
