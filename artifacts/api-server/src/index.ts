import app from "./app";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/sync/scheduler";
import { startAutoPrintScheduler } from "./lib/printQueue/autoPrint/scheduler";
import { bootstrapStaffAdmin } from "./lib/auth/bootstrap";

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
  startScheduler(logger);
  startAutoPrintScheduler(logger);
});
