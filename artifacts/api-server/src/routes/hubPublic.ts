/**
 * PUBLIC (unauthenticated) Hub routes.
 *
 * GET /hub/uploads/:token/:filename — serves a Hub Price Calculator PNG by
 * its high-entropy public token. Printavo fetches this URL asynchronously
 * after productionFileCreate. The trailing :filename segment is cosmetic —
 * it controls how Printavo labels the attached file.
 *
 * No session required. The token IS the access control.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getHubCalcPngStream } from "../lib/hub/pngStorage";

const router: IRouter = Router();

const serveHubCalcPng = async (
  req: Request<{ token: string; filename: string }>,
  res: Response,
): Promise<void> => {
  const { token } = req.params;
  // Validate token is 64-char hex (prevents trivial enumeration of any token format)
  if (!/^[0-9a-f]{64}$/.test(token)) {
    res.status(404).send("Not found");
    return;
  }
  try {
    const result = await getHubCalcPngStream(token);
    if (!result) {
      res.status(404).send("Not found");
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.contentLength) {
      res.setHeader("Content-Length", result.contentLength);
    }
    result.stream.pipe(res);
    result.stream.on("error", (err) => {
      req.log.error({ err }, "Hub calc PNG stream error");
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    req.log.error({ err }, "Hub calc PNG serve failed");
    if (!res.headersSent) res.status(500).send("Serve failed");
  }
};

router.get("/hub/uploads/:token/:filename", serveHubCalcPng);

export default router;
