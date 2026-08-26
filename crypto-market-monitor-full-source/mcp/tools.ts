import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AlgoBotStatusSchema,
  BybitBotsOutputSchema,
  ControlCenterBootstrapSchema,
  DashboardOverviewSchema,
  DecisionExplanationSchema,
  PortfolioOutputSchema,
  RiskStatusSchema,
  SystemHealthSchema,
} from "../src/cryptobot/domain.ts";
import type { CryptoBotGateway } from "../src/cryptobot/gateway.ts";
import { safeToolError, toolResult } from "./tool-result.ts";

export const CONTROL_CENTER_URI = "ui://cryptobot/control-center/v1.html";

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

export function oauthSecuritySchemes() {
  return [{ type: "oauth2" as const, scopes: ["cryptobot.read"] }];
}

export const CRYPTOBOT_TOOL_SPECS = [
  { name: "open_control_center", rendersWidget: true },
  { name: "get_dashboard_overview", rendersWidget: false },
  { name: "get_algobot_status", rendersWidget: false },
  { name: "get_bybit_bots", rendersWidget: false },
  { name: "get_portfolio", rendersWidget: false },
  { name: "get_risk_status", rendersWidget: false },
  { name: "get_system_health", rendersWidget: false },
  { name: "explain_decision", rendersWidget: false },
] as const;

export function createCryptoBotToolHandlers(gateway: CryptoBotGateway) {
  return {
    async open_control_center() {
      const data = await gateway.getControlCenterBootstrap();
      return toolResult(data as unknown as Record<string, unknown>, "מרכז השליטה של CryptoBot מוכן.");
    },
    async get_dashboard_overview() {
      const data = await gateway.getDashboardOverview();
      return toolResult(data as unknown as Record<string, unknown>, "התקבלה תמונת מצב עדכנית של CryptoBot.");
    },
    async get_algobot_status() {
      const data = await gateway.getAlgoBotStatus();
      return toolResult(data as unknown as Record<string, unknown>, `נמצאו ${data.strategies.length} אסטרטגיות במודל הקריאה.`);
    },
    async get_bybit_bots() {
      const data = await gateway.getBybitBots();
      const summary = data.details_available
        ? `נמצאו ${data.bots.length} בוטים של Bybit.`
        : "נתוני חשבון הבוטים של Bybit זמינים ברמת החשבון; פירוט בוטים בודדים אינו זמין ממקור קריאה מאומת.";
      return toolResult(data as unknown as Record<string, unknown>, summary);
    },
    async get_portfolio() {
      const data = await gateway.getPortfolio();
      return toolResult(data as unknown as Record<string, unknown>, `התיק כולל ${data.assets.length} נכסים מוצגים ו-${data.positions.length} פוזיציות פתוחות.`);
    },
    async get_risk_status() {
      const data = await gateway.getRiskStatus();
      return toolResult(data as unknown as Record<string, unknown>, `מצב התאמת הפוזיציות: ${data.reconciliation_state}.`);
    },
    async get_system_health() {
      const data = await gateway.getSystemHealth();
      return toolResult(data as unknown as Record<string, unknown>, `מצב המערכת: ${data.overall_state}.`);
    },
    async explain_decision(decisionId: string) {
      const data = await gateway.explainDecision(decisionId);
      return toolResult(data as unknown as Record<string, unknown>, data.explanation_he);
    },
  };
}

function commonDescriptor() {
  const securitySchemes = oauthSecuritySchemes();
  return {
    annotations: READ_ONLY_ANNOTATIONS,
    securitySchemes,
    _meta: {
      securitySchemes,
      ui: { visibility: ["model", "app"] },
    },
  };
}

export function registerCryptoBotTools(server: McpServer, gateway: CryptoBotGateway) {
  const handlers = createCryptoBotToolHandlers(gateway);

  registerAppTool(server, "open_control_center", {
    title: "פתח את מרכז השליטה של CryptoBot",
    description: "Use this when the user wants to open or return to the full CryptoBot dashboard inside ChatGPT. It is read-only and renders the control-center widget.",
    inputSchema: {},
    outputSchema: ControlCenterBootstrapSchema.shape,
    ...commonDescriptor(),
    _meta: {
      ...commonDescriptor()._meta,
      ui: { resourceUri: CONTROL_CENTER_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": CONTROL_CENTER_URI,
      "openai/toolInvocation/invoking": "פותח את מרכז השליטה…",
      "openai/toolInvocation/invoked": "מרכז השליטה מוכן",
    },
  }, async () => {
    try { return await handlers.open_control_center(); }
    catch (error) { throw safeToolError(error); }
  });

  registerAppTool(server, "get_dashboard_overview", {
    title: "קבל סקירת CryptoBot",
    description: "Use this when the user asks for the current portfolio, P&L, open-position, alert, or overall CryptoBot status summary.",
    inputSchema: {},
    outputSchema: DashboardOverviewSchema.shape,
    ...commonDescriptor(),
  }, async () => {
    try { return await handlers.get_dashboard_overview(); }
    catch (error) { throw safeToolError(error); }
  });

  registerAppTool(server, "get_algobot_status", {
    title: "קבל מצב AlgoBot",
    description: "Use this when the user asks about AlgoBot strategies, signals, decisions, modes, or strategy performance.",
    inputSchema: {},
    outputSchema: AlgoBotStatusSchema.shape,
    ...commonDescriptor(),
  }, async () => {
    try { return await handlers.get_algobot_status(); }
    catch (error) { throw safeToolError(error); }
  });

  registerAppTool(server, "get_bybit_bots", {
    title: "קבל מצב בוטים של Bybit",
    description: "Use this when the user asks about Bybit built-in bots. Return only data supported by the approved read-only account sources; never infer individual bot P&L.",
    inputSchema: {},
    outputSchema: BybitBotsOutputSchema.shape,
    ...commonDescriptor(),
  }, async () => {
    try { return await handlers.get_bybit_bots(); }
    catch (error) { throw safeToolError(error); }
  });

  registerAppTool(server, "get_portfolio", {
    title: "קבל תיק ועסקאות",
    description: "Use this when the user asks for account breakdown, holdings, open positions, prices, protection, or recent executions.",
    inputSchema: {},
    outputSchema: PortfolioOutputSchema.shape,
    ...commonDescriptor(),
  }, async () => {
    try { return await handlers.get_portfolio(); }
    catch (error) { throw safeToolError(error); }
  });

  registerAppTool(server, "get_risk_status", {
    title: "קבל מצב סיכון",
    description: "Use this when the user asks about risk limits, exposure, kill-switch state, protection, or reconciliation.",
    inputSchema: {},
    outputSchema: RiskStatusSchema.shape,
    ...commonDescriptor(),
  }, async () => {
    try { return await handlers.get_risk_status(); }
    catch (error) { throw safeToolError(error); }
  });

  registerAppTool(server, "get_system_health", {
    title: "קבל בריאות מערכת",
    description: "Use this when the user asks whether CryptoBot, Bybit connectivity, market streams, or the read-only safety boundary are healthy and fresh.",
    inputSchema: {},
    outputSchema: SystemHealthSchema.shape,
    ...commonDescriptor(),
  }, async () => {
    try { return await handlers.get_system_health(); }
    catch (error) { throw safeToolError(error); }
  });

  registerAppTool(server, "explain_decision", {
    title: "הסבר החלטת AlgoBot",
    description: "Use this when the user wants to understand one persisted AlgoBot decision. The explanation must use recorded decision facts only.",
    inputSchema: { decision_id: z.string().regex(/^\\d+$/).max(30) },
    outputSchema: DecisionExplanationSchema.shape,
    ...commonDescriptor(),
  }, async ({ decision_id }) => {
    try { return await handlers.explain_decision(decision_id); }
    catch (error) { throw safeToolError(error); }
  });
}
