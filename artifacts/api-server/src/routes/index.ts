import { Router, type IRouter } from "express";
import healthRouter from "./health";
import syncRouter from "./sync";
import printavoRouter from "./printavo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(syncRouter);
router.use(printavoRouter);

export default router;
