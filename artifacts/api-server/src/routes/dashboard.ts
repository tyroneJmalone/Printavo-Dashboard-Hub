import { Router, type IRouter } from "express";
import { getDashboardMetrics } from "../lib/hub/dashboardMetrics";

const router: IRouter = Router();
router.get("/dashboard/metrics", async (req, res) => {
  try {
    res.json(await getDashboardMetrics());
  } catch (err) {
    req.log.error({ err }, "Dashboard metrics failed");
    res.status(500).json({ error: "Dashboard metrics unavailable" });
  }
});
export default router;