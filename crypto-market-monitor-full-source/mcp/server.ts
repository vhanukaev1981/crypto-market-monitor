import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  extractBearerToken,
  verifyBearerToken,
  type CryptoBotPrincipal,
} from "./auth.ts";
import { createCryptoBotMcpServer } from "./create-server.ts";

export type OAuthProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
};

export function oauthProtectedResourceMetadata(
  resourceUrl: string,
  issuer: string,
): OAuthProtectedResourceMetadata {
  return {
    resource: resourceUrl,
    authorization_servers: [issuer.replace(/\/$/, "")],
    scopes_supported: ["email"],
    bearer_methods_supported: ["header"],
  };
}

export function unauthorizedHeaders(metadataUrl: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="email"`,
  };
}

type Session = {
  transport: StreamableHTTPServerTransport;
  subject: string;
};

type ServerOptions = {
  resourceUrl?: string;
  issuer?: string;
  verifyToken?: (token: string) => Promise<CryptoBotPrincipal>;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function jsonRpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

export function createCryptoBotHttpApp(options: ServerOptions = {}) {
  const resourceUrl = options.resourceUrl ?? requiredEnv("CRYPTOBOT_RESOURCE_URL");
  const issuer = (options.issuer ?? requiredEnv("CRYPTOBOT_OAUTH_ISSUER")).replace(/\/$/, "");
  const metadataUrl = new URL("../.well-known/oauth-protected-resource", resourceUrl).toString();
  const verifyToken = options.verifyToken ?? verifyBearerToken;
  const sessions = new Map<string, Session>();
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"],
    exposedHeaders: ["mcp-session-id", "mcp-protocol-version", "www-authenticate"],
    maxAge: 86400,
  }));
  app.use(express.json({ limit: "1mb" }));

  const metadata = oauthProtectedResourceMetadata(resourceUrl, issuer);
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.set("cache-control", "public, max-age=300").json(metadata);
  });
  app.get("/mcp/.well-known/oauth-protected-resource", (_req, res) => {
    res.set("cache-control", "public, max-age=300").json(metadata);
  });
  app.get("/health", (_req, res) => {
    res.set("cache-control", "no-store").json({
      ok: true,
      service: "cryptobot-mcp",
      mode: "private_read_only",
    });
  });

  async function principalFor(req: Request, res: Response): Promise<CryptoBotPrincipal | null> {
    try {
      const token = extractBearerToken(req.header("authorization"));
      return await verifyToken(token);
    } catch {
      res.set(unauthorizedHeaders(metadataUrl)).status(401).json({
        error: "authentication_required",
      });
      return null;
    }
  }

  app.post("/mcp", async (req, res) => {
    const principal = await principalFor(req, res);
    if (!principal) return;

    const sessionId = req.header("mcp-session-id") ?? undefined;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return jsonRpcError(res, 404, -32001, "Session not found");
      if (session.subject !== principal.subject) {
        return jsonRpcError(res, 403, -32003, "Session principal mismatch");
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      return jsonRpcError(res, 400, -32000, "Initialization request required");
    }

    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, subject: principal.subject });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createCryptoBotMcpServer(principal);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionVerb = async (req: Request, res: Response) => {
    const principal = await principalFor(req, res);
    if (!principal) return;
    const sessionId = req.header("mcp-session-id") ?? undefined;
    if (!sessionId) return jsonRpcError(res, 400, -32000, "Mcp-Session-Id required");
    const session = sessions.get(sessionId);
    if (!session) return jsonRpcError(res, 404, -32001, "Session not found");
    if (session.subject !== principal.subject) {
      return jsonRpcError(res, 403, -32003, "Session principal mismatch");
    }
    await session.transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionVerb);
  app.delete("/mcp", handleSessionVerb);

  return app;
}

export function startCryptoBotMcpServer() {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error("invalid_port");
  const app = createCryptoBotHttpApp();
  return app.listen(port, "0.0.0.0", () => {
    console.log(`CryptoBot MCP listening on ${port}`);
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  startCryptoBotMcpServer();
}
