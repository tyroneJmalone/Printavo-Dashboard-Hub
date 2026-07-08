import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
