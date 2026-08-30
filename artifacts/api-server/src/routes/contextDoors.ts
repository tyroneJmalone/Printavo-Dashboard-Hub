import { Router, type IRouter, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  callerFromConsumer,
  resolveConsumerFromAuthHeader,
} from "../lib/contextCore/auth";
import { executeContextTool } from "../lib/contextCore/dispatch";
import { toolsForCaller } from "../lib/contextCore/tools";
import type { ContextCaller } from "../lib/contextCore/types";
import { isContextLayerEnabled } from "../lib/aiGuardrails";

/**
 * The context layer's external doors — MCP (Streamable HTTP) and key-authed
 * REST. Mounted in the PUBLIC section of the route tree (before
 * requireStaff): callers are AI platforms, not browser sessions. Every
 * request must carry a valid consumer bearer token; everything else
 * (tiers, scopes, rate limits, kill switch, audit) is enforced by the
 * shared dispatch path.
 *
 * Mailbox/email content is NEVER exposed through these doors — no tool in
 * the registry touches correspondence tables, by design.
 */
const router: IRouter = Router();

async function authenticate(req: Request, res: Response): Promise<ContextCaller | null> {
  const consumer = await resolveConsumerFromAuthHeader(req.headers.authorization);
  if (!consumer) {
    res.status(401).json({ error: "Missing or invalid consumer token" });
    return null;
  }
  if (!(await isContextLayerEnabled())) {
    res.status(503).json({ error: "The AI context layer is currently disabled" });
    return null;
  }
  return callerFromConsumer(consumer);
}

function buildMcpServer(caller: ContextCaller): McpServer {
  const server = new McpServer({
    name: "printavo-hub-context",
    version: "1.0.0",
  });
  for (const tool of toolsForCaller(caller)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema.shape,
      },
      async (args: Record<string, unknown>) => {
        const result = await executeContextTool({
          caller,
          surface: "context_mcp",
          tool: tool.name,
          args,
        });
        if (!result.ok) {
          return {
            content: [
              { type: "text" as const, text: `Error (${result.errorCode}): ${result.message}` },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
          ],
        };
      },
    );
  }
  return server;
}

// ── MCP door (Streamable HTTP, stateless) ────────────────────────────
router.post("/context/mcp", async (req, res): Promise<void> => {
  const caller = await authenticate(req, res);
  if (!caller) return;
  const server = buildMcpServer(caller);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless server: no sessions to resume or delete.
const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless MCP server)" },
    id: null,
  });
};
router.get("/context/mcp", methodNotAllowed);
router.delete("/context/mcp", methodNotAllowed);

// ── REST door ────────────────────────────────────────────────────────
router.get("/context/v1/tools", async (req, res): Promise<void> => {
  const caller = await authenticate(req, res);
  if (!caller) return;
  res.json({
    tools: toolsForCaller(caller).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      isAction: tool.isAction,
    })),
  });
});

const REST_ERROR_STATUS: Record<string, number> = {
  CONTEXT_DISABLED: 503,
  UNKNOWN_TOOL: 404,
  FORBIDDEN_TIER: 403,
  FORBIDDEN_SCOPE: 403,
  RATE_LIMITED: 429,
  INVALID_ARGS: 400,
  TOOL_ERROR: 500,
};

router.post("/context/v1/tools/:name", async (req, res): Promise<void> => {
  const caller = await authenticate(req, res);
  if (!caller) return;
  const raw = req.params.name;
  const toolName = Array.isArray(raw) ? raw[0]! : raw;
  const args =
    req.body && typeof req.body === "object" && "arguments" in req.body
      ? (req.body as { arguments: unknown }).arguments
      : req.body;
  const result = await executeContextTool({
    caller,
    surface: "context_rest",
    tool: toolName,
    args: args ?? {},
  });
  if (!result.ok) {
    const status = REST_ERROR_STATUS[result.errorCode] ?? 500;
    if (result.retryAfterSeconds) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
    }
    res.status(status).json({ ok: false, error: result.errorCode, message: result.message });
    return;
  }
  res.json({ ok: true, cached: result.cached, data: result.data });
});

export default router;
