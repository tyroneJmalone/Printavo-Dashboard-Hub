import { Router, type IRouter, type Request, type Response } from "express";
import { getPoFileByHtmlToken } from "../lib/purchasing/poFiles";
import { renderPoHtml } from "../lib/purchasing/poHtml";

/**
 * PUBLIC (unauthenticated) purchasing routes — mounted BEFORE requireStaff.
 *
 * PO HTML by secret token: the URL handed to Printavo's
 * productionFileCreate. The token is a 64-char hex secret, regenerated on
 * every push; this must stay the ONLY public purchasing endpoint (Printavo
 * fetches it server-to-server with no session). The optional trailing
 * :filename segment is ignored — it only makes Printavo name the attached
 * file after the PO number.
 */
const router: IRouter = Router();

const servePublicPoHtml = (
  req: Request<{ token: string; filename?: string }>,
  res: Response,
) => {
  getPoFileByHtmlToken(req.params.token)
    .then((po) => {
      if (!po) {
        res.status(404).send("Not found");
        return;
      }
      res.type("html").send(renderPoHtml(po));
    })
    .catch((err) => {
      req.log.error({ err }, "public PO render failed");
      res.status(500).send("Render failed");
    });
};
router.get("/purchasing/po-html/:token", servePublicPoHtml);
router.get("/purchasing/po-html/:token/:filename", servePublicPoHtml);

export default router;
