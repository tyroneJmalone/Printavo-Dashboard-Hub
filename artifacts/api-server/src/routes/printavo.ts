import { Router, type IRouter } from "express";
import { probeQuery, type StatusesPage } from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../lib/printavoGateway";

const router: IRouter = Router();

router.get("/printavo/probe", async (req, res) => {
  if (!printavoConfigured()) {
    res.json({
      ok: false,
      message:
        "Printavo credentials are not configured (PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN)",
    });
    return;
  }
  try {
    const client = getPrintavoClient();
    const data = await client.query<StatusesPage>(probeQuery());
    const first = data.statuses.nodes[0];
    res.json({
      ok: true,
      message: first
        ? `Connected to Printavo — first status visible: "${first.name}"`
        : "Connected to Printavo — no statuses returned",
    });
  } catch (err) {
    req.log.error({ err }, "Printavo probe failed");
    res.json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
