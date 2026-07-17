import { Router, type IRouter } from "express";
import healthRouter from "./health";
import purchasingPublicRouter from "./purchasingPublic";
import { requireStaff } from "../middlewares/requireStaff";
import authRouter from "./auth";
import syncRouter from "./sync";
import printavoRouter from "./printavo";
import reportsRouter from "./reports";
import reportsValidatorRouter from "./reportsValidator";
import purchasingRouter from "./purchasing";
import pricingRouter from "./pricing";
import printQueueRouter from "./printQueue";

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
router.use(syncRouter);
router.use(printavoRouter);
router.use(reportsRouter);
router.use(reportsValidatorRouter);
router.use(purchasingRouter);
router.use(pricingRouter);
router.use(printQueueRouter);

export default router;
