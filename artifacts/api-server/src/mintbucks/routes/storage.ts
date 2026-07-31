import { Router, type IRouter, type Request, type Response } from "express";
import { RequestMbUploadUrlBody, RequestMbUploadUrlResponse } from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * POST /mintbucks/storage/uploads/request-url
 *
 * Staff-only (mounted behind requireStaff like the rest of the Mint Bucks
 * routes): mint a presigned PUT URL so the browser can upload a reward-rule
 * or credit image directly to the hub's bucket. The client sends JSON
 * metadata only — never the file itself.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response): Promise<void> => {
  const parsed = RequestMbUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const svc = new ObjectStorageService();
    const uploadURL = await svc.getObjectEntityUploadURL();
    const objectPath = svc.normalizeObjectEntityPath(uploadURL);
    res.json(RequestMbUploadUrlResponse.parse({ uploadURL, objectPath }));
  } catch (err) {
    logger.error({ err }, "Mint Bucks: failed to generate upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

export default router;
