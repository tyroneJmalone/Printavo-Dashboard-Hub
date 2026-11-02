import { Router, type IRouter } from "express";
import { GetAdminUpdatesResponse } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import documents from "hub-planning-documents";
import releases from "../../../../docs/hub-changelog.json";

// Validate curated content at startup, not after an administrator opens it.
const updates = GetAdminUpdatesResponse.parse({ releases, documents });
const router: IRouter = Router();
router.get("/auth/admin-updates", requireAdmin, (_req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json(updates);
});
export default router;
