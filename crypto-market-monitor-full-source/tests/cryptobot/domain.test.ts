import assert from "node:assert/strict";
import test from "node:test";
import {
  BybitBotsOutputSchema,
  DashboardOverviewSchema,
  FreshnessStateSchema,
  SourceMetaSchema,
  SystemHealthSchema,
} from "../../src/cryptobot/domain.ts";

test("freshness states are explicit", () => {
  assert.deepEqual(FreshnessStateSchema.options, ["fresh", "aging", "stale", "unavailable"]);
});

test("source metadata carries explicit freshness and health", () => {
  const parsed = SourceMetaSchema.parse({
    observed_at: "2026-08-26T12:00:00.000Z",
    age_seconds: 7,
    freshness_state: "fresh",
    source_state: "ok",
  });
  assert.equal(parsed.age_seconds, 7);
});

test("unknown financial values remain null instead of becoming zero", () => {
  const overview = DashboardOverviewSchema.parse({
    portfolio_equity_usd: null,
    pnl: { day_usd: null, week_usd: null, month_usd: null },
    drawdown_pct: null,
    deployed_capital_pct: null,
    open_positions: null,
    algobot: { active_strategies: null, pnl_usd: null, mode_summary: {} },
    bybit_bots: { count: null, equity_usd: null, pnl_usd: null },
    latest_decision: null,
    alerts: [],
    system_state: "limited",
    sources: {},
  });
  assert.equal(overview.portfolio_equity_usd, null);
  assert.equal(overview.pnl.day_usd, null);
});

test("Bybit bot details can be explicitly unavailable without inventing performance", () => {
  const result = BybitBotsOutputSchema.parse({
    bots: [],
    total_bot_account_equity_usd: 100,
    details_available: false,
    details_status: "strategy_list_unavailable",
    source: { observed_at: null, age_seconds: null, freshness_state: "unavailable", source_state: "attention" },
  });
  assert.equal(result.details_available, false);
  assert.equal(result.bots.length, 0);
});

test("system health is structurally read-only", () => {
  const health = SystemHealthSchema.parse({
    overall_state: "healthy",
    components: [],
    authorization_mode: "read_only",
    exchange_trading_enabled: false,
    withdrawals_enabled: false,
    source: { observed_at: null, age_seconds: null, freshness_state: "unavailable", source_state: "unknown" },
  });
  assert.equal(health.authorization_mode, "read_only");
  assert.equal(health.exchange_trading_enabled, false);
  assert.equal(health.withdrawals_enabled, false);
});
