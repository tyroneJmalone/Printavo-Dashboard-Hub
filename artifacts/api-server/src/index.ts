import app from "./app";
import { startPrintscopeWorker } from "./lib/printscope/worker";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/sync/scheduler";
import { startFileMirror } from "./lib/sync/fileMirror";
import { startAutoPrintScheduler } from "./lib/printQueue/autoPrint/scheduler";
import { startCatalogScheduler } from "./lib/catalog/scheduler";
import { startEmailActivityScheduler } from "./lib/emailActivity/scheduler";
import { bootstrapStaffAdmin } from "./lib/auth/bootstrap";
import { seedCustomerCategories } from "./lib/customers/seedCategories";
import { ensureInsightsRole } from "./lib/insights/guard";
import { isMintbucksConfigured } from "@workspace/mintbucks-db";
import { startPoller as startMintbucksPoller } from "./mintbucks/lib/poller";
import { startTaskSyncPoller } from "./printavoTasks/poller";
import { startColorEvidenceWorker } from "./lib/catalog/evidenceWorker";
import { startKnowledgeDriveScheduler } from "./lib/knowledgeDriveScheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  bootstrapStaffAdmin(logger).catch((err) =>
    logger.error({ err }, "staff admin bootstrap failed"),
  );
  seedCustomerCategories(logger).catch((err) =>
    logger.error({ err }, "customer category seed failed"),
  );
  ensureInsightsRole(logger).catch((err) =>
    logger.error({ err }, "insights role setup failed"),
  );
  startScheduler(logger);
  startPrintscopeWorker().catch(() => logger.warn("PrintScope processing unavailable; other modules unaffected"));
  startFileMirror(logger);
  startAutoPrintScheduler(logger);
  startCatalogScheduler(logger);
  startColorEvidenceWorker(logger);
  // Email activity tracker — dormant until GOOGLE_SERVICE_ACCOUNT_JSON is set.
  startEmailActivityScheduler(logger);
  startKnowledgeDriveScheduler(logger);
  // Mint Bucks poller: dormant unless MINTBUCKS_POLLER_ENABLED=true (phased
  // ownership handoff — the standalone app keeps polling until Tyler flips it).
  if (isMintbucksConfigured()) {
    startMintbucksPoller().catch((err) =>
      logger.error({ err }, "Mint Bucks poller failed to start"),
    );
  }
  // Printavo ⇄ moMINTum task-sync poller: dormant unless
  // PRINTAVO_TASK_SYNC_ENABLED=true — and that flag must be true in at most
  // ONE environment (dev vs deployment duplicate-twin hazard, see replit.md).
  startTaskSyncPoller(logger);
});
