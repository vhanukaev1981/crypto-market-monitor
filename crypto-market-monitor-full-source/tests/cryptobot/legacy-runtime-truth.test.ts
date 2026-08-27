import assert from "node:assert/strict";
import test from "node:test";

import { mapAlgoBotStatus } from "../../src/cryptobot/gateway/algobot.ts";
import { mapDashboardOverview } from "../../src/cryptobot/gateway/overview.ts";
import { mapRiskStatus } from "../../src/cryptobot/gateway/risk.ts";
import { mapSystemHealth } from "../../src/cryptobot/gateway/system-health.ts";
import { normalizeBybitBotVisibility } from "../../src/cryptobot/bybit-bot-normalizer.ts";

const NOW = Date.parse("2026-08-27T03:25:00.000Z");
const OLD = "2026-08-06T23:30:00.000Z";

const stoppedRuntime = [{
  status: "stopped",
  enabled: false,
  kill_switch: true,
  updated_at: OLD,
  last_run_at: OLD,
  strategy: { mode: "live", strategies: ["legacy_strategy"] },
  risk: {
    reference_capital_usdt: 350,
    max_daily_loss_usdt: 60,
    max_usdt_per_trade: 30,
    max_open_positions: 2,
    require_native_protection: true,
  },
}];

test("stopped legacy AlgoBot marks historical strategy evidence as non-current", () => {
  const result = mapAlgoBotStatus(
    [{ strategy_key: "legacy_strategy", trades: 124, wins: 60, net_pnl: -4.71, updated_at: OLD }],
    [{ id: 42, strategy_key: "legacy_strategy", symbol: "BTCUSDT", signal: "hold", eligible: false, created_at: OLD }],
    stoppedRuntime,
    false,
    NOW,
  );

  assert.equal(result.strategies[0]?.status, "inactive");
  assert.equal(result.source.freshness_state, "stale");
  assert.equal(result.source.source_state, "attention");
});

test("stopped legacy risk runtime does not present historical counters or alerts as current", () => {
  const result = mapRiskStatus(
    {
      reference_capital_usdt: 350,
      realized_today: 0,
      open_exposure_usdt: 0,
      open_positions: 0,
      protected_positions: 0,
    },
    stoppedRuntime,
    [{ id: 1, severity: "critical", code: "OLD_EMERGENCY", message: "historical event", created_at: OLD }],
    false,
    NOW,
  );

  assert.equal(result.kill_switch, true);
  assert.equal(result.daily_loss_pct, null);
  assert.equal(result.daily_loss_limit_pct, null);
  assert.equal(result.exposure_usd, null);
  assert.equal(result.open_positions, null);
  assert.deepEqual(result.recent_events, []);
  assert.equal(result.source.source_state, "attention");
});

test("overview suppresses inactive legacy PnL and decision while preserving current Bybit equity", () => {
  const algobot = mapAlgoBotStatus(
    [{ strategy_key: "legacy_strategy", trades: 124, wins: 60, net_pnl: -4.71, updated_at: OLD }],
    [{ id: 42, strategy_key: "legacy_strategy", symbol: "BTCUSDT", signal: "hold", eligible: false, created_at: OLD }],
    stoppedRuntime,
    false,
    NOW,
  );
  const risk = mapRiskStatus(
    { reference_capital_usdt: 350, realized_today: 0, open_exposure_usdt: 0, open_positions: 0, protected_positions: 0 },
    stoppedRuntime,
    [{ id: 1, severity: "critical", code: "OLD_EMERGENCY", message: "historical event", created_at: OLD }],
    false,
    NOW,
  );
  const bybitBots = normalizeBybitBotVisibility({
    account: { account_type_breakdown: [{ type: "ACCOUNT_TYPE_BOT", usd_value: 248.23 }] },
    checked_at: "2026-08-27T03:24:30.000Z",
    last_error: null,
  }, NOW);
  const system = mapSystemHealth(
    { checked_at: "2026-08-27T03:24:30.000Z", last_error: null },
    { status: "connected", is_read_only: true, trading_enabled: false, withdrawals_enabled: false, last_checked_at: "2026-08-27T03:24:30.000Z" },
    stoppedRuntime,
    null,
    null,
    { exchange: false, engine: false, stream: false, orderbook: false },
    NOW,
  );

  const overview = mapDashboardOverview(
    { account_equity_usdt: 1105.32, realized_today: 0, open_exposure_usdt: 0, open_positions: 0 },
    { account: { total_assets_usd: 1105.32 } },
    algobot,
    bybitBots,
    risk,
    system,
  );

  assert.equal(overview.portfolio_equity_usd, 1105.32);
  assert.equal(overview.algobot.active_strategies, 0);
  assert.equal(overview.algobot.pnl_usd, null);
  assert.equal(overview.pnl.day_usd, null);
  assert.equal(overview.latest_decision, null);
  assert.deepEqual(overview.alerts, []);
  assert.equal(overview.system_state, "protection");
});
