import assert from "node:assert/strict";
import test from "node:test";
import type { CryptoBotGateway } from "../../src/cryptobot/gateway.ts";
import {
  CONTROL_CENTER_URI,
  CRYPTOBOT_TOOL_SPECS,
  READ_ONLY_ANNOTATIONS,
  createCryptoBotToolHandlers,
  oauthSecuritySchemes,
} from "../../mcp/tools.ts";

const expectedNames = [
  "open_control_center",
  "get_dashboard_overview",
  "get_algobot_status",
  "get_bybit_bots",
  "get_portfolio",
  "get_risk_status",
  "get_system_health",
  "explain_decision",
];

test("V1 advertises only the approved read-only tool set", () => {
  assert.deepEqual(CRYPTOBOT_TOOL_SPECS.map((tool) => tool.name), expectedNames);
  assert.deepEqual(READ_ONLY_ANNOTATIONS, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.deepEqual(oauthSecuritySchemes(), [{ type: "oauth2", scopes: ["cryptobot.read"] }]);
});

test("only open_control_center is allowed to render the widget", () => {
  const renderers = CRYPTOBOT_TOOL_SPECS.filter((tool) => tool.rendersWidget).map((tool) => tool.name);
  assert.deepEqual(renderers, ["open_control_center"]);
  assert.equal(CONTROL_CENTER_URI, "ui://cryptobot/control-center/v1.html");
});

test("no V1 tool name exposes exchange mutation semantics", () => {
  const joined = CRYPTOBOT_TOOL_SPECS.map((tool) => tool.name).join(" ");
  for (const forbidden of ["place_order", "cancel_order", "close_position", "withdraw", "pause_strategy", "resume_strategy", "kill_switch"]) {
    assert.equal(joined.includes(forbidden), false, `forbidden tool surface: ${forbidden}`);
  }
});

test("tool handlers return authoritative gateway data without adding trade actions", async () => {
  const gateway = {
    getBybitBots: async () => ({
      bots: [], total_bot_account_equity_usd: 200, details_available: false, details_status: "account_level_only",
      source: { observed_at: null, age_seconds: null, freshness_state: "unavailable", source_state: "unknown" },
    }),
    getSystemHealth: async () => ({
      overall_state: "healthy", components: [], authorization_mode: "read_only", exchange_trading_enabled: false, withdrawals_enabled: false,
      source: { observed_at: null, age_seconds: null, freshness_state: "unavailable", source_state: "unknown" },
    }),
  } as unknown as CryptoBotGateway;
  const handlers = createCryptoBotToolHandlers(gateway);
  const bots = await handlers.get_bybit_bots();
  assert.equal(bots.structuredContent.total_bot_account_equity_usd, 200);
  assert.match(bots.content[0].text, /פירוט בוטים בודדים אינו זמין/);
  const health = await handlers.get_system_health();
  assert.equal(health.structuredContent.authorization_mode, "read_only");
  assert.equal(health.structuredContent.exchange_trading_enabled, false);
});
