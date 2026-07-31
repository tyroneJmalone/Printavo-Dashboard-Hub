import { Readable } from "stream";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../mintbucks/lib/objectStorage";
import { ObjectPermission } from "../mintbucks/lib/objectAcl";

const router: IRouter = Router();

/**
 * GET /mintbucks/images/objects/*
 *
 * PUBLIC (no staff session): serves Mint Bucks email images. Email clients
 * fetch these anonymously, so this route must sit above requireStaff.
 *
 * Only objects whose ACL policy is explicitly public are served — everything
 * else in the bucket stays 403. If the object isn't in the hub's bucket it
 * was uploaded from the standalone Mint Bucks app, so we redirect to that
 * app's serve route (MINTBUCKS_APP_URL) instead of 404ing.
 */
router.get(
  "/mintbucks/images/objects/*path",
  async (req: Request, res: Response) => {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;

    // Defense in depth: canonical object paths only.
    if (!/^\/objects\/[A-Za-z0-9._/-]+$/.test(objectPath)) {
      res.status(400).json({ error: "Invalid object path" });
      return;
    }

    const svc = new ObjectStorageService();
    try {
      const objectFile = await svc.getObjectEntityFile(objectPath);
      const canAccess = await svc.canAccessObjectEntity({
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      if (!canAccess) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const response = await svc.downloadObject(objectFile);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        // Not in the hub's bucket — likely uploaded via the standalone Mint
        // Bucks app, which stores in its own bucket. Redirect to its serve
        // route so both storage locations render everywhere.
        const standaloneUrl = process.env.MINTBUCKS_APP_URL;
        if (standaloneUrl) {
          res.redirect(302, `${standaloneUrl}/api/storage${encodeURI(objectPath)}`);
          return;
        }
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error({ err: error }, "Error serving Mint Bucks image");
      res.status(500).json({ error: "Failed to serve object" });
    }
  },
);

export default router;
