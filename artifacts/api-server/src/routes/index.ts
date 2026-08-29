import { Router, type IRouter } from "express";
import healthRouter from "./health";
import purchasingPublicRouter from "./purchasingPublic";
import hubPublicRouter from "./hubPublic";
import { requireStaff } from "../middlewares/requireStaff";
import authRouter from "./auth";
import staffRouter from "./staff";
import syncRouter from "./sync";
import backupRouter from "./backup";
import printavoRouter from "./printavo";
import reportsRouter from "./reports";
import reportsValidatorRouter from "./reportsValidator";
import insightsRouter from "./insights";
import chipplyRouter from "./chipply";
import purchasingRouter from "./purchasing";
import collectionsRouter from "./collections";
import catalogPantonesRouter from "./catalogPantones";
import pricingRouter from "./pricing";
import printQueueRouter from "./printQueue";
import sorterRouter from "./sorter";
import shippingRouter from "./shipping";
import customersRouter from "./customers";
import customerBrandingRouter from "./customerBranding";
import pipelineRouter from "./pipeline";
import statusActivityRouter from "./statusActivity";
import emailActivityRouter from "./emailActivity";
import aiQuotesRouter from "./aiQuotes";
import emailAccessRouter from "./emailAccess";
import correspondenceRouter from "./correspondence";
import hubRouter from "./hub";
import { isMomintumConfigured } from "@workspace/momintum-db";
import momintumRouter from "../momintum";
import { isMintbucksConfigured } from "@workspace/mintbucks-db";
import mintbucksRouter from "../mintbucks/routes";
import mintbucksPublicRouter from "./mintbucksPublic";
import { printavoConfigured } from "../lib/printavoGateway";
import printavoTasksRouter from "../printavoTasks/routes";

const router: IRouter = Router();

// ── Public (no session) ──────────────────────────────────────────────
// ONLY /healthz, the tokenized PO HTML that Printavo fetches
// server-to-server, and the Hub calc PNG that Printavo fetches after
// productionFileCreate. Everything below requireStaff needs a session.
router.use(healthRouter);
router.use(purchasingPublicRouter);
// Hub calc PNG — fetched anonymously by Printavo after productionFileCreate.
router.use(hubPublicRouter);
// Mint Bucks email images — fetched anonymously by email clients.
if (isMintbucksConfigured()) {
  router.use(mintbucksPublicRouter);
}

// ── Staff-only ───────────────────────────────────────────────────────
router.use(requireStaff);
router.use(authRouter);
router.use(staffRouter); // admin-only routes — requireAdmin per route inside
router.use(syncRouter);
router.use(backupRouter); // /backup/export is admin-only (requireAdmin per route)
router.use(printavoRouter);
router.use(reportsRouter);
router.use(reportsValidatorRouter);
router.use(insightsRouter);
router.use(chipplyRouter);
router.use(purchasingRouter);
router.use(collectionsRouter);
router.use(catalogPantonesRouter);
router.use(pricingRouter);
router.use(printQueueRouter);
router.use(sorterRouter);
router.use(shippingRouter);
router.use(customersRouter); // category manage routes are admin-only inside
router.use(customerBrandingRouter); // branding/artwork writes are admin-only inside
router.use(pipelineRouter);
router.use(statusActivityRouter);
router.use(emailActivityRouter); // config is admin-only; analytics are mailbox-ACL scoped
router.use(aiQuotesRouter);
router.use(emailAccessRouter);
router.use(correspondenceRouter);
router.use(hubRouter);

// moMINTum task management — shared LIVE database with the standalone app.
// Only mounted when MOMINTUM_DATABASE_URL is set (removing the secret is the
// kill switch).
if (isMomintumConfigured()) {
  router.use("/momintum", momintumRouter);
}

// Mint Bucks store credit — shared LIVE database with the standalone app.
// Only mounted when MINTBUCKS_DATABASE_URL is set (removing the secret is the
// kill switch). Poller stays dormant unless MINTBUCKS_POLLER_ENABLED=true.
if (isMintbucksConfigured()) {
  router.use("/mintbucks", mintbucksRouter);
}

// Printavo ⇄ moMINTum task sync — needs both the moMINTum DB and Printavo
// credentials. Admin-gated inside; manual trigger only until the interval
// poller phase ships.
if (isMomintumConfigured() && printavoConfigured()) {
  router.use("/printavo-tasks", printavoTasksRouter);
}

export default router;
