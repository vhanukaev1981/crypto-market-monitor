import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { freshnessHebrew } from "../../mcp/web/src/format.ts";
import { normalizeBybitBotVisibility } from "../../src/cryptobot/bybit-bot-normalizer.ts";
import { mapPortfolio } from "../../src/cryptobot/gateway/portfolio.ts";
import { mapSystemHealth } from "../../src/cryptobot/gateway/system-health.ts";

const NOW = Date.parse("2026-08-27T03:10:00.000Z");
const API_WRAPPER_SOURCE = readFileSync(
  new URL("../../supabase/functions/cryptobot-api/index.ts", import.meta.url),
  "utf8",
);

test("Bybit bot allocations are reported as detected instead of unknown", () => {
  const result = normalizeBybitBotVisibility({
    account: {
      account_type_breakdown: [
        { type: "ACCOUNT_TYPE_BOT", usd_value: 248.23 },
      ],
      eth_breakdown: [
        { account_type: "FundingAccount", category: null, quantity: 0.00016916 },
        { account_type: "TradingBot", category: "Spot Grid Bot", quantity: 0.04554899 },
        { account_type: "TradingBot", category: "DCA Bot", quantity: 0.00808211 },
      ],
    },
    checked_at: "2026-08-27T03:09:30.000Z",
    last_error: null,
  }, NOW);

  assert.equal(result.total_bot_account_equity_usd, 248.23);
  assert.equal(result.bots.length, 2);
  assert.deepEqual(result.bots.map((bot) => bot.kind), ["spot_grid", "dca"]);
  assert.equal(result.bots.every((bot) => bot.status === "detected"), true);
  assert.deepEqual(
    result.bots.map((bot) => bot.observed_eth_quantity),
    [0.04554899, 0.00808211],
  );
});

test("stopped legacy runtime is protection, not healthy, and its streams are inactive", () => {
  const health = mapSystemHealth(
    { checked_at: "2026-08-27T03:09:30.000Z", last_error: null },
    {
      status: "connected",
      is_read_only: true,
      trading_enabled: false,
      withdrawals_enabled: false,
      last_checked_at: "2026-08-27T03:09:30.000Z",
      last_error: null,
    },
    [{ status: "stopped", enabled: false, kill_switch: true, updated_at: "2026-08-06T23:37:50.000Z" }],
    { connected: false, updated_at: "2026-08-06T23:00:00.000Z", last_error: null },
    { connected: false, updated_at: "2026-08-05T23:00:00.000Z", last_error: null },
    { exchange: false, engine: false, stream: false, orderbook: false },
    NOW,
  );

  assert.equal(health.overall_state, "protection");
  const legacy = health.components.find((component) => component.key === "algobot");
  assert.equal(legacy?.label, "Legacy AlgoBot Runtime");
  assert.equal(legacy?.state, "attention");
  assert.match(legacy?.message ?? "", /stopped|מושבת|הגנה/i);

  for (const key of ["private_stream", "orderbook"]) {
    const component = health.components.find((item) => item.key === key);
    assert.equal(component?.state, "unknown");
    assert.match(component?.message ?? "", /inactive|מושבת|לא פעיל/i);
  }
});

test("portfolio explicitly declares when visible asset rows cover Unified only", () => {
  const portfolio = mapPortfolio(
    {
      account: {
        total_assets_usd: 1105.32,
        total_equity: 317.08,
        account_type_breakdown: [
          { type: "ACCOUNT_TYPE_FUND", usd_value: 540.01 },
          { type: "ACCOUNT_TYPE_UNIFIED", usd_value: 317.08 },
          { type: "ACCOUNT_TYPE_BOT", usd_value: 248.23 },
        ],
      },
      checked_at: "2026-08-27T03:09:30.000Z",
      last_error: null,
    },
    [{ coin: "USDT", equity: 317.06, usd_value: 317.03, asset_class: "Unified" }],
    [],
    [],
    false,
    NOW,
  );

  assert.equal(portfolio.total_equity_usd, 1105.32);
  assert.equal(portfolio.assets_scope, "unified_only");
  assert.equal(portfolio.account_breakdown.length, 3);
  assert.equal(portfolio.assets.reduce((sum, asset) => sum + (asset.usd_value ?? 0), 0) < portfolio.total_equity_usd!, true);
});

test("Lovable compatibility does not fabricate a live runtime pipeline with unknown stages", () => {
  assert.doesNotMatch(API_WRAPPER_SOURCE, /const pipeline = \[[\s\S]*status: "unknown"[\s\S]*\];/);
  assert.doesNotMatch(API_WRAPPER_SOURCE, /\bpipeline,\s*\n\s*latest_decision:/);
});

test("Lovable compatibility exposes safely stopped legacy services as inactive", () => {
  assert.match(API_WRAPPER_SOURCE, /legacy_algobot[\s\S]{0,700}inactive/);
  assert.match(API_WRAPPER_SOURCE, /private_stream[\s\S]{0,700}inactive/);
  assert.match(API_WRAPPER_SOURCE, /orderbook_stream[\s\S]{0,700}inactive/);
});

test("Lovable compatibility preserves the ALGO V2 research freshness window", () => {
  assert.match(API_WRAPPER_SOURCE, /researchSourceCompat/);
  assert.match(API_WRAPPER_SOURCE, /21_600/);
  assert.match(API_WRAPPER_SOURCE, /86_400/);
  assert.match(API_WRAPPER_SOURCE, /freshness_state/);
});

test("ChatGPT widget labels both canonical aging and compatibility delayed research data as updating", () => {
  assert.equal(freshnessHebrew("aging"), "מתעדכן");
  assert.equal(freshnessHebrew("delayed"), "מתעדכן");
});
