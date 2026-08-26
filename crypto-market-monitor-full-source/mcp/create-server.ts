import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CryptoBotPrincipal } from "./auth.ts";
import { createCryptoBotGateway, type CryptoBotGateway } from "../src/cryptobot/gateway.ts";
import { CONTROL_CENTER_URI, registerCryptoBotTools } from "./tools.ts";

function loadWidgetHtml(): string {
  const root = process.cwd();
  const shell = readFileSync(resolve(root, "mcp/web/index.html"), "utf8");
  const bundle = readFileSync(resolve(root, "mcp/dist/widget.js"), "utf8");
  if (!shell.includes("__CRYPTOBOT_WIDGET_BUNDLE__")) throw new Error("widget_shell_placeholder_missing");
  return shell.replace("__CRYPTOBOT_WIDGET_BUNDLE__", bundle);
}

function resourceMeta() {
  const domain = process.env.CRYPTOBOT_WIDGET_DOMAIN?.trim();
  const ui: Record<string, unknown> = {
    prefersBorder: false,
    csp: {
      connectDomains: [],
      resourceDomains: [],
    },
  };
  if (domain && /^https:\/\//i.test(domain)) ui.domain = domain.replace(/\/$/, "");
  return { ui };
}

export function createCryptoBotMcpServer(
  principal: CryptoBotPrincipal,
  options: { gateway?: CryptoBotGateway; widgetHtml?: string } = {},
): McpServer {
  const server = new McpServer(
    { name: "cryptobot-control-center", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: "CryptoBot V1 is private and read-only. Never claim that a tool can place, cancel, modify, or close an exchange order. Keep AlgoBot performance separate from Bybit built-in bot/account metrics, surface data freshness, and use persisted decision facts only.",
    },
  );

  const gateway = options.gateway ?? createCryptoBotGateway(principal);
  registerCryptoBotTools(server, gateway);

  registerAppResource(
    server,
    "cryptobot-control-center",
    CONTROL_CENTER_URI,
    {},
    async () => ({
      contents: [{
        uri: CONTROL_CENTER_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: options.widgetHtml ?? loadWidgetHtml(),
        _meta: resourceMeta(),
      }],
    }),
  );

  return server;
}
