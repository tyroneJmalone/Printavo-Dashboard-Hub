import { Router, type IRouter } from "express";
import { getDashboardMetrics, PERIOD_KEYS, type DashboardPeriod } from "../lib/hub/dashboardMetrics";
import { getDashboardDetails, PERFORMANCE_METRICS, type PerformanceMetric } from "../lib/hub/dashboardDetails";

const router: IRouter = Router();
router.get("/dashboard/details", async (req, res) => {
  const { metric, period, offset = "0" } = req.query;
  if (typeof metric !== "string" || !PERFORMANCE_METRICS.includes(metric as PerformanceMetric) ||
    typeof period !== "string" || !PERIOD_KEYS.includes(period as DashboardPeriod) ||
    typeof offset !== "string" || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
    res.status(400).json({ error: "Invalid metric, period, or offset" }); return;
  }
  try {
    res.json(await getDashboardDetails(metric as PerformanceMetric, period as DashboardPeriod, Number(offset)));
  } catch (err) {
    req.log.error({ err }, "Dashboard detail failed");
    res.status(500).json({ error: "Dashboard detail unavailable" });
  }
});
router.get("/dashboard/metrics", async (req, res) => {
  try {
    res.json(await getDashboardMetrics());
  } catch (err) {
    req.log.error({ err }, "Dashboard metrics failed");
    res.status(500).json({ error: "Dashboard metrics unavailable" });
  }
});
export default router;