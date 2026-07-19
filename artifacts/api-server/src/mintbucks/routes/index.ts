import { Router, type IRouter } from "express";
import customersRouter from "./customers";
import creditsRouter from "./credits";
import redemptionsRouter from "./redemptions";
import reportsRouter from "./reports";
import settingsRouter from "./settings";
import printavoRouter from "./printavo";
import rewardsRouter from "./rewards";

const router: IRouter = Router();

router.use(customersRouter);
router.use(creditsRouter);
router.use(redemptionsRouter);
router.use(reportsRouter);
router.use(settingsRouter);
router.use(printavoRouter);
router.use(rewardsRouter);

export default router;
