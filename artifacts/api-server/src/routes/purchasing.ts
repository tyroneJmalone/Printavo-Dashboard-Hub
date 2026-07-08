import { Router, type IRouter } from "express";
import { loadNeedsOrdering } from "../lib/purchasing/needsOrdering";

/**
 * Purchasing (Vendor Orders) module routes. Phase 1: needs-ordering scan.
 * Reads Postgres ONLY — module-isolation requirement.
 */

const router: IRouter = Router();

router.get("/purchasing/needs-ordering", (req, res) => {
  loadNeedsOrdering()
    .then((result) => res.json(result))
    .catch((err) => {
      req.log.error({ err }, "Needs-ordering scan failed");
      res.status(500).json({ error: "Needs-ordering scan failed" });
    });
});

export default router;
