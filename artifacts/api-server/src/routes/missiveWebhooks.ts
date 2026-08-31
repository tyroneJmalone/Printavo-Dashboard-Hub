import { Router, type IRouter, type Request, type Response } from "express";
import {
  getWebhookSecret,
  receivePatternWebhook,
  verifyMissiveSignature,
} from "../lib/draftPatterns/service";

/**
 * PUBLIC Missive webhook receivers (rule actions in Missive). No Clerk
 * session — authenticity comes from the HMAC signature Missive computes
 * over the raw body with the shared signature secret (managed on the Hub's
 * AI Connections page, pasted into the Missive rule).
 *
 * Two endpoints so each drafting pattern is its own Missive rule:
 *   POST /missive/webhooks/context-note  → Pattern B (note + Missive AI Rule)
 *   POST /missive/webhooks/voice-draft   → Pattern C (Hub voice-matched draft)
 */
const router: IRouter = Router();

function handler(pattern: "B" | "C") {
  return async (req: Request, res: Response): Promise<void> => {
    const secret = await getWebhookSecret();
    if (!secret) {
      res.status(503).json({
        error:
          "Missive webhook secret is not configured. Generate one on the Hub's AI Connections page first.",
      });
      return;
    }
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.get("x-hook-signature") ?? undefined;
    if (!rawBody || !verifyMissiveSignature(rawBody, signature, secret)) {
      req.log.warn({ pattern, hasSignature: Boolean(signature) }, "Missive webhook rejected");
      res.status(401).json({ error: "invalid webhook signature" });
      return;
    }
    const result = await receivePatternWebhook(pattern, req.body, rawBody, req.log);
    if (!result.accepted) {
      // 200 anyway — Missive retries 5 times on non-2xx and the payload
      // will not grow a conversation id on retry.
      res.json({ ok: false, reason: result.reason });
      return;
    }
    res.json({ ok: true, eventId: result.eventId });
  };
}

router.post("/missive/webhooks/context-note", handler("B"));
router.post("/missive/webhooks/voice-draft", handler("C"));

export default router;
