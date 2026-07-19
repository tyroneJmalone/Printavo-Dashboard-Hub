import { Router, type IRouter } from "express";
import healthRouter from "./health";
import purchasingPublicRouter from "./purchasingPublic";
import { requireStaff } from "../middlewares/requireStaff";
import authRouter from "./auth";
import staffRouter from "./staff";
import syncRouter from "./sync";
import printavoRouter from "./printavo";
import reportsRouter from "./reports";
import reportsValidatorRouter from "./reportsValidator";
import purchasingRouter from "./purchasing";
import pricingRouter from "./pricing";
import printQueueRouter from "./printQueue";
import sorterRouter from "./sorter";
import shippingRouter from "./shipping";
import { isMomintumConfigured } from "@workspace/momintum-db";
import momintumRouter from "../momintum";

const router: IRouter = Router();

// ── Public (no session) ──────────────────────────────────────────────
// ONLY /healthz and the tokenized PO HTML that Printavo fetches
// server-to-server. Everything below the requireStaff line needs an
// allowlisted staff session (Clerk cookie).
router.use(healthRouter);
router.use(purchasingPublicRouter);

// ── Staff-only ───────────────────────────────────────────────────────
router.use(requireStaff);
router.use(authRouter);
router.use(staffRouter); // admin-only routes — requireAdmin per route inside
router.use(syncRouter);
router.use(printavoRouter);
router.use(reportsRouter);
router.use(reportsValidatorRouter);
router.use(purchasingRouter);
router.use(pricingRouter);
router.use(printQueueRouter);
router.use(sorterRouter);
router.use(shippingRouter);

// moMINTum task management — shared LIVE database with the standalone app.
// Only mounted when MOMINTUM_DATABASE_URL is set (removing the secret is the
// kill switch).
if (isMomintumConfigured()) {
  router.use("/momintum", momintumRouter);
}

export default router;
