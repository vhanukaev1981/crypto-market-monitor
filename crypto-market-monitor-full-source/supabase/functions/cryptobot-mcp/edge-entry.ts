import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "npm:hono@4.9.12";
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.30.0/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.30.0/server/webStandardStreamableHttp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "npm:@modelcontextprotocol/ext-apps@1.7.5/server";
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
} from "https://raw.githubusercontent.com/vhanukaev1981/crypto-market-monitor/2b20d9e3276c36643736eb3f2e7cfaad46f3ddc4/crypto-market-monitor-full-source/supabase/functions/cryptobot-mcp/data.ts";

const FUNCTION_NAME = "cryptobot-mcp";
const PROJECT_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const MCP_URL = `${PROJECT_URL}/functions/v1/${FUNCTION_NAME}/mcp`;
const RESOURCE_METADATA_URL = `${PROJECT_URL}/functions/v1/${FUNCTION_NAME}/.well-known/oauth-protected-resource`;
const CONTROL_CENTER_URI = "ui://cryptobot/control-center/v1.html";
const STANDARD_SCOPES = ["email"];
const WIDGET_URL = "https://raw.githubusercontent.com/vhanukaev1981/crypto-market-monitor/2b20d9e3276c36643736eb3f2e7cfaad46f3ddc4/crypto-market-monitor-full-source/supabase/functions/cryptobot-mcp/widget.html";

if (!PROJECT_URL) throw new Error("SUPABASE_URL_missing");

const widgetResponse = await fetch(WIDGET_URL, { headers: { Accept: "text/html" } });
if (!widgetResponse.ok) throw new Error(`widget_fetch_failed:${widgetResponse.status}`);
const widgetHtml = await widgetResponse.text();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version",
};

function unauthorized() {
  return new Response(JSON.stringify({ error: "authorization_required" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="${STANDARD_SCOPES.join(" ")}"`,
      ...cors,
    },
  });
}

async function principalFor(request: Request): Promise<Principal | null> {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get("authorization") ?? "").trim());
  return match?.[1] ? await authenticateBearer(match[1].trim()) : null;
}

const securitySchemes = [{ type: "oauth2" as const, scopes: STANDARD_SCOPES }];
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };

function result(data: unknown, summary: string) {
  return { content: [{ type: "text" as const, text: summary }], structuredContent: data as Record<string, unknown> };
}

function meta(render = false) {
  const out: Record<string, unknown> = { securitySchemes, ui: { visibility: ["model", "app"] } };
  if (render) {
    out.ui = { resourceUri: CONTROL_CENTER_URI, visibility: ["model", "app"] };
    out["openai/outputTemplate"] = CONTROL_CENTER_URI;
    out["openai/toolInvocation/invoking"] = "פותח את מרכז השליטה…";
    out["openai/toolInvocation/invoked"] = "מרכז השליטה מוכן";
  }
  return out;
}

function createServer(principal: Principal) {
  const server = new McpServer(
    { name: "cryptobot-control-center", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: "Private read-only CryptoBot control center. Never place, modify, cancel, close, transfer, or withdraw. Keep AlgoBot metrics separate from Bybit built-in bot metrics. Mark stale data explicitly. Explain decisions from persisted facts only.",
    },
  );

  registerAppResource(server, "cryptobot-control-center", CONTROL_CENTER_URI, {}, async () => ({
    contents: [{
      uri: CONTROL_CENTER_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: widgetHtml,
      _meta: {
        ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "מרכז שליטה פרטי לקריאה בלבד עבור CryptoBot, AlgoBot, Bybit, תיק, סיכון ובריאות המערכת.",
      },
    }],
  }));

  const common = { annotations, securitySchemes };

  registerAppTool(server, "open_control_center", {
    title: "פתח את מרכז השליטה של CryptoBot",
    description: "Open the private read-only CryptoBot control center inside ChatGPT.",
    inputSchema: {}, ...common, _meta: meta(true),
  } as any, async () => result(await getControlCenterBootstrap(principal.userId), "מרכז השליטה נטען ממקורות הקריאה המאושרים."));

  registerAppTool(server, "get_dashboard_overview", {
    title: "קבל סקירת CryptoBot", description: "Current portfolio, P&L, positions, latest decision, alerts, and system state.", inputSchema: {}, ...common, _meta: meta(),
  } as any, async () => result(await getDashboardOverview(principal.userId), "התקבלה תמונת מצב עדכנית של CryptoBot."));

  registerAppTool(server, "get_algobot_status", {
    title: "קבל מצב AlgoBot", description: "AlgoBot strategies, signals, decisions, modes, and performance only.", inputSchema: {}, ...common, _meta: meta(),
  } as any, async () => {
    const data = await getAlgoBotStatus(principal.userId);
    return result(data, `נטענו ${data.strategies.length} אסטרטגיות AlgoBot.`);
  });

  registerAppTool(server, "get_bybit_bots", {
    title: "קבל מצב בוטים של Bybit", description: "Verified read-only Bybit bot-account data. Never infer missing Grid/DCA performance fields.", inputSchema: {}, ...common, _meta: meta(),
  } as any, async () => {
    const data = await getBybitBots(principal.userId);
    return result(data, data.details_status);
  });

  registerAppTool(server, "get_portfolio", {
    title: "קבל תיק ועסקאות", description: "Account breakdown, assets, open positions, and recent executions.", inputSchema: {}, ...common, _meta: meta(),
  } as any, async () => {
    const data = await getPortfolio(principal.userId);
    return result(data, `התיק כולל ${data.assets.length} נכסים מוצגים ו-${data.positions.length} פוזיציות פתוחות.`);
  });

  registerAppTool(server, "get_risk_status", {
    title: "קבל מצב סיכון", description: "Risk limits, exposure, kill switch, reconciliation, protection, and risk events.", inputSchema: {}, ...common, _meta: meta(),
  } as any, async () => {
    const data = await getRiskStatus(principal.userId);
    return result(data, `מצב ההתאמה: ${data.reconciliation_state}.`);
  });

  registerAppTool(server, "get_system_health", {
    title: "קבל בריאות מערכת", description: "Bybit freshness, permission boundary, AlgoBot, streams, trading and withdrawal restrictions.", inputSchema: {}, ...common, _meta: meta(),
  } as any, async () => {
    const data = await getSystemHealth(principal.userId);
    return result(data, `מצב המערכת: ${data.overall_state}.`);
  });

  registerAppTool(server, "explain_decision", {
    title: "הסבר החלטת AlgoBot", description: "Explain one persisted AlgoBot decision using recorded facts only.",
    inputSchema: { decision_id: z.string().regex(/^\d+$/).max(30) }, ...common, _meta: meta(),
  } as any, async ({ decision_id }: { decision_id: string }) => {
    const data = await explainDecision(principal.userId, decision_id);
    return result(data, data.explanation_he);
  });

  return server;
}

const app = new Hono().basePath(`/${FUNCTION_NAME}`);
app.options("*", () => new Response(null, { status: 204, headers: cors }));
app.get("/health", (c) => c.json({ ok: true, service: "cryptobot-mcp", mode: "read_only", mcp: "/mcp" }));
app.get("/.well-known/oauth-protected-resource", (c) => c.json({ resource: MCP_URL, authorization_servers: [authServerUrl()], scopes_supported: STANDARD_SCOPES, bearer_methods_supported: ["header"] }));
app.all("/mcp", async (c) => {
  const principal = await principalFor(c.req.raw);
  if (!principal) return unauthorized();
  const server = createServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(c.req.raw);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    queueMicrotask(() => { transport.close().catch(() => undefined); server.close().catch(() => undefined); });
  }
});

Deno.serve(app.fetch);
