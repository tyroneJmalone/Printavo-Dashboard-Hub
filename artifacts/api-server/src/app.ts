import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Behind the Replit edge proxy: resolve req.ip from X-Forwarded-For (one
// trusted hop) so per-IP rate limits key on the real client, not the proxy.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
/**
 * Cross-origin requests are only allowed from this Repl's own domains
 * (the hub is same-origin through the proxy; this blocks arbitrary sites
 * from scripting the API). Requests with no Origin header — curl, server-to-
 * server fetches like Printavo pulling the PO HTML — are unaffected by CORS.
 */
const allowedOrigins = new Set(
  [
    ...(process.env.REPLIT_DOMAINS?.split(",") ?? []),
    process.env.REPLIT_DEV_DOMAIN ?? "",
  ]
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => `https://${d}`),
);
// Clerk auth proxy (production only) — must come BEFORE body parsers,
// the proxy streams raw bytes.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
  }),
);
app.use(
  express.json({
    limit: "300kb",
    // Missive webhooks are HMAC-signed over the raw bytes — keep them for
    // signature verification on those routes only.
    verify: (req, _res, buf) => {
      if ((req as { url?: string }).url?.startsWith("/api/missive/")) {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
