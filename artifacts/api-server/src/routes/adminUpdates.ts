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
  // These records are bundled with this server, so a deployed server is evidence
  // of inclusion. It is NOT evidence of their original publication date.
  const deployed = process.env.REPLIT_DEPLOYMENT === "1" && process.env.NODE_ENV === "production";
  res.json({
    ...updates,
    releases: updates.releases.map((release) =>
      deployed && release.status === "prepared" ? { ...release, status: "published" as const } : release),
  });
});
export default router;
