import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "npm:hono@4.9.12";
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.30.0/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.30.0/server/webStandardStreamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "npm:@modelcontextprotocol/ext-apps@1.7.5/server";
import { z } from "npm:zod@4.4.3";

import {
  authenticateBearer,
  authServerUrl,
  explainDecision,
  getAlgoBotStatus,
  getBybitBots,
  getControlCenterBootstrap,
  getDashboardOverview,
  getPortfolio,
  getRiskStatus,
  getSystemHealth,
  type Principal,
} from "./data.ts";

const FUNCTION_NAME = "cryptobot-mcp";
const PROJECT_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const MCP_URL = `${PROJECT_URL}/functions/v1/${FUNCTION_NAME}/mcp`;
const RESOURCE_METADATA_URL = `${PROJECT_URL}/functions/v1/${FUNCTION_NAME}/.well-known/oauth-protected-resource`;
const CONTROL_CENTER_URI = "ui://cryptobot/control-center/v1.html";
const STANDARD_SCOPES = ["openid", "email"];

if (!PROJECT_URL) throw new Error("SUPABASE_URL_missing");

const widgetHtml = await Deno.readTextFile(new URL("./widget.html", import.meta.url));

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version",
  };
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "authorization_required" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="${STANDARD_SCOPES.join(" ")}"`,
      ...corsHeaders(),
    },
  });
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

async function principalFor(request: Request): Promise<Principal | null> {
  const token = bearerToken(request);
  if (!token) return null;
  return await authenticateBearer(token);
}

function toolResult(data: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: data,
  };
}

function annotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  };
}

function securitySchemes() {
  return [{ type: "oauth2" as const, scopes: STANDARD_SCOPES }];
}

function toolMeta(render = false) {
  const security = securitySchemes();
  const meta: Record<string, unknown> = {
    securitySchemes: security,
    ui: { visibility: ["model", "app"] },
  };
  if (render) {
    meta.ui = { resourceUri: CONTROL_CENTER_URI, visibility: ["model", "app"] };
    meta["openai/outputTemplate"] = CONTROL_CENTER_URI;
    meta["openai/toolInvocation/invoking"] = "פותח את מרכז השליטה…";
    meta["openai/toolInvocation/invoked"] = "מרכז השליטה מוכן";
  }
  return meta;
}

function createServer(principal: Principal) {
  const server = new McpServer(
    { name: "cryptobot-control-center", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: "CryptoBot V1 is private and read-only. Never place, cancel, modify, close, transfer, or withdraw funds. Keep AlgoBot metrics separate from Bybit built-in bot metrics. Surface stale data explicitly and explain decisions only from persisted facts.",
    },
  );

  registerAppResource(
    server,
    "cryptobot-control-center",
    CONTROL_CENTER_URI,
    {},
    async () => ({
      contents: [{
        uri: CONTROL_CENTER_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          "openai/widgetDescription": "מרכז שליטה פרטי לקריאה בלבד עבור CryptoBot, AlgoBot, Bybit, תיק, סיכון ובריאות המערכת.",
        },
      }],
    }),
  );

  const common = {
    annotations: annotations(),
    securitySchemes: securitySchemes(),
  };

  registerAppTool(server, "open_control_center", {
    title: "פתח את מרכז השליטה של CryptoBot",
    description: "Use this when the user wants to open or return to the private CryptoBot dashboard inside ChatGPT. Read-only; renders the fullscreen-capable widget.",
    inputSchema: {},
    ...common,
    _meta: toolMeta(true),
  } as any, async () => {
    const data = await getControlCenterBootstrap(principal.userId);
    return toolResult(data as unknown as Record<string, unknown>, "מרכז השליטה של CryptoBot נטען ממקורות הקריאה המאושרים.");
  });

  registerAppTool(server, "get_dashboard_overview", {
    title: "קבל סקירת CryptoBot",
    description: "Use this for current portfolio equity, daily P&L, open positions, latest AlgoBot decision, alerts, and overall system state.",
    inputSchema: {}, ...common, _meta: toolMeta(false),
  } as any, async () => toolResult(await getDashboardOverview(principal.userId) as any, "התקבלה תמונת מצב עדכנית של CryptoBot."));

  registerAppTool(server, "get_algobot_status", {
    title: "קבל מצב AlgoBot",
    description: "Use this for AlgoBot strategies, signals, decisions, strategy modes, and performance. Never mix these metrics with Bybit built-in bots.",
    inputSchema: {}, ...common, _meta: toolMeta(false),
  } as any, async () => {
    const data = await getAlgoBotStatus(principal.userId);
    return toolResult(data as any, `נטענו ${data.strategies.length} אסטרטגיות AlgoBot.`);
  });

  registerAppTool(server, "get_bybit_bots", {
    title: "קבל מצב בוטים של Bybit",
    description: "Use this for verified read-only Bybit bot-account visibility. Do not infer individual Grid/DCA P&L, investment, range, or grid count when the source does not provide it.",
    inputSchema: {}, ...common, _meta: toolMeta(false),
  } as any, async () => {
    const data = await getBybitBots(principal.userId);
    return toolResult(data as any, data.details_status);
  });

  registerAppTool(server, "get_portfolio", {
    title: "קבל תיק ועסקאות",
    description: "Use this for account breakdown, assets, open positions, protection values, and recent executions.",
    inputSchema: {}, ...common, _meta: toolMeta(false),
  } as any, async () => {
    const data = await getPortfolio(principal.userId);
    return toolResult(data as any, `התיק כולל ${data.assets.length} נכסים מוצגים ו-${data.positions.length} פוזיציות פתוחות.`);
  });

  registerAppTool(server, "get_risk_status", {
    title: "קבל מצב סיכון",
    description: "Use this for exposure, position limits, kill-switch state, reconciliation, native-protection requirement, and recent risk events.",
    inputSchema: {}, ...common, _meta: toolMeta(false),
  } as any, async () => {
    const data = await getRiskStatus(principal.userId);
    return toolResult(data as any, `מצב ההתאמה: ${data.reconciliation_state}.`);
  });

  registerAppTool(server, "get_system_health", {
    title: "קבל בריאות מערכת",
    description: "Use this to verify Bybit snapshot freshness, read-only permission boundary, AlgoBot state, private stream, orderbook stream, and withdrawal/trading restrictions.",
    inputSchema: {}, ...common, _meta: toolMeta(false),
  } as any, async () => {
    const data = await getSystemHealth(principal.userId);
    return toolResult(data as any, `מצב המערכת: ${data.overall_state}.`);
  });

  registerAppTool(server, "explain_decision", {
    title: "הסבר החלטת AlgoBot",
    description: "Use this to explain one persisted AlgoBot decision from recorded facts only. If no detailed rationale was stored, say so explicitly.",
    inputSchema: { decision_id: z.string().regex(/^\d+$/).max(30) },
    ...common,
    _meta: toolMeta(false),
  } as any, async ({ decision_id }: { decision_id: string }) => {
    const data = await explainDecision(principal.userId, decision_id);
    return toolResult(data as any, data.explanation_he);
  });

  return server;
}

const app = new Hono().basePath(`/${FUNCTION_NAME}`);

app.options("*", (c) => new Response(null, { status: 204, headers: corsHeaders() }));

app.get("/health", (c) => c.json({
  ok: true,
  service: "cryptobot-mcp",
  mode: "read_only",
  mcp: "/mcp",
}));

app.get("/.well-known/oauth-protected-resource", (c) => c.json({
  resource: MCP_URL,
  authorization_servers: [authServerUrl()],
  scopes_supported: STANDARD_SCOPES,
  bearer_methods_supported: ["header"],
}));

app.all("/mcp", async (c) => {
  const principal = await principalFor(c.req.raw);
  if (!principal) return unauthorized();

  const server = createServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(c.req.raw);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    queueMicrotask(() => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
  }
});

Deno.serve(app.fetch);
