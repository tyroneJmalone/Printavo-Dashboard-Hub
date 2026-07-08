import { Router, type IRouter } from "express";
import healthRouter from "./health";
import syncRouter from "./sync";
import printavoRouter from "./printavo";
import reportsRouter from "./reports";
import reportsValidatorRouter from "./reportsValidator";

const router: IRouter = Router();

router.use(healthRouter);
router.use(syncRouter);
router.use(printavoRouter);
router.use(reportsRouter);
router.use(reportsValidatorRouter);

export default router;
