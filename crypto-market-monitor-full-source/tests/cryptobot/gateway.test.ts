import assert from "node:assert/strict";
import test from "node:test";
import type { CryptoBotPrincipal } from "../../mcp/auth.ts";
import { createCryptoBotGateway } from "../../src/cryptobot/gateway.ts";
import type { CryptoBotRepository, RepoResult, Row } from "../../src/cryptobot/repository.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-08-26T12:02:00.000Z");
const principal: CryptoBotPrincipal = { subject: "user:owner", email: "owner@example.test", supabaseUserId: USER_ID };

function ok<T>(data: T): RepoResult<T> { return { data, error: null }; }

class FakeRepository implements CryptoBotRepository {
  seenUserIds: string[] = [];
  errors = new Set<string>();
  snapshot: Row | null = {
    account: {
      total_assets_usd: 1100,
      account_type_breakdown: [
        { type: "FUND", usd_value: 600 },
        { type: "UNIFIED", usd_value: 300 },
        { type: "TradingBot", usd_value: 200 },
      ],
    },
    checked_at: "2026-08-26T12:01:30.000Z",
    last_error: null,
  };
  dashboard: Row | null = {
    account_equity_usdt: 1100,
    reference_capital_usdt: 350,
    open_positions: 1,
    protected_positions: 1,
    open_exposure_usdt: 110,
    realized_today: 4,
  };
  assets: Row[] = [{ coin: "ETH", equity: 0.02, usd_value: 60, checked_at: "2026-08-26T12:01:30.000Z" }];
  positions: Row[] = [{ position_id: "p1", market: "spot", direction: "long", symbol: "ETHUSDT", qty: 0.02, entry_price: 2900, current_price: 3000, notional_usdt: 60, unrealized_pnl: 2, protection_status: "native_verified", strategy_key: "trend_pullback_v2", opened_at: "2026-08-26T11:00:00.000Z" }];
  executions: Row[] = [{ id: "e1", symbol: "ETHUSDT", side: "Buy", qty: 0.02, price: 2900, fee_usdt: 0.05, realized_pnl: 0, executed_at: "2026-08-26T11:00:00.000Z" }];
  bots: Row[] = [{ bot_id: "b1", enabled: true, kill_switch: false, environment: "shadow", last_run_at: "2026-08-26T12:01:55.000Z", risk: { reference_capital_usdt: 350, max_daily_loss_usdt: 35, max_open_positions: 2, require_native_protection: true }, strategy: { mode: "shadow", strategies: ["trend_pullback_v2"] } }];
  performance: Row[] = [{ strategy_key: "trend_pullback_v2", trades: 10, wins: 6, net_pnl: 12, expectancy_usdt: 1.2, updated_at: "2026-08-26T12:01:50.000Z" }];
  decisions: Row[] = [{ id: 42, symbol: "ETHUSDT", strategy_key: "trend_pullback_v2", signal: "hold", eligible: false, rejection_codes: ["VOLATILITY_TOO_HIGH"], spread_bps: 1.5, estimated_slippage_bps: 4, expected_net_edge_bps: 20, metadata: { decision: { score: 61, reason: "VOLATILITY_TOO_HIGH", confidence: 0.61 }, analysis: { regime: "trend", regimeConfidence: 0.8 } }, created_at: "2026-08-26T12:01:45.000Z" }];
  riskEvents: Row[] = [];
  connection: Row | null = { status: "connected", is_read_only: true, trading_enabled: false, withdrawals_enabled: false, last_checked_at: "2026-08-26T12:01:30.000Z", last_error: null };
  stream: Row | null = { connected: true, last_message_at: "2026-08-26T12:01:55.000Z", updated_at: "2026-08-26T12:01:55.000Z", last_error: null };
  orderbook: Row | null = { connected: true, last_sample_at: "2026-08-26T12:01:55.000Z", updated_at: "2026-08-26T12:01:55.000Z", last_error: null };

  private track<T>(key: string, userId: string, value: T): RepoResult<T> {
    this.seenUserIds.push(userId);
    return { data: value, error: this.errors.has(key) ? `${key}_failed` : null };
  }
  async getLiveSnapshot(userId: string) { return this.track("snapshot", userId, this.snapshot); }
  async getDashboardSummary(userId: string) { return this.track("dashboard", userId, this.dashboard); }
  async getAccountAssets(userId: string) { return this.track("assets", userId, this.assets); }
  async getOpenPositions(userId: string) { return this.track("positions", userId, this.positions); }
  async getExecutions(userId: string) { return this.track("executions", userId, this.executions); }
  async getBotStatuses(userId: string) { return this.track("bots", userId, this.bots); }
  async getStrategyPerformance(userId: string) { return this.track("performance", userId, this.performance); }
  async getStrategyDecisions(userId: string) { return this.track("decisions", userId, this.decisions); }
  async getStrategyDecision(userId: string, decisionId: string) { return this.track("decision", userId, this.decisions.find((item) => String(item.id) === decisionId) ?? null); }
  async getRiskEvents(userId: string) { return this.track("riskEvents", userId, this.riskEvents); }
  async getExchangeConnection(userId: string) { return this.track("connection", userId, this.connection); }
  async getStreamState(userId: string) { return this.track("stream", userId, this.stream); }
  async getOrderbookStreamState(userId: string) { return this.track("orderbook", userId, this.orderbook); }
}

test("gateway scopes every repository read to authenticated principal", async () => {
  const repo = new FakeRepository();
  const gateway = createCryptoBotGateway(principal, repo, () => NOW);
  await gateway.getControlCenterBootstrap();
  assert.ok(repo.seenUserIds.length > 10);
  assert.equal(repo.seenUserIds.every((value) => value === USER_ID), true);
});

test("overview separates AlgoBot PnL from Bybit bot-account equity", async () => {
  const repo = new FakeRepository();
  const overview = await createCryptoBotGateway(principal, repo, () => NOW).getDashboardOverview();
  assert.equal(overview.portfolio_equity_usd, 1100);
  assert.equal(overview.algobot.pnl_usd, 12);
  assert.equal(overview.bybit_bots.equity_usd, 200);
  assert.equal(overview.bybit_bots.pnl_usd, null);
  assert.equal(overview.bybit_bots.count, null);
});

test("partial source failure preserves useful portfolio data and marks source fault", async () => {
  const repo = new FakeRepository();
  repo.errors.add("assets");
  const portfolio = await createCryptoBotGateway(principal, repo, () => NOW).getPortfolio();
  assert.equal(portfolio.total_equity_usd, 1100);
  assert.equal(portfolio.positions.length, 1);
  assert.equal(portfolio.source.source_state, "fault");
});

test("stale Bybit snapshot remains visible but is explicitly stale", async () => {
  const repo = new FakeRepository();
  repo.snapshot = { ...repo.snapshot, checked_at: "2026-08-26T11:50:00.000Z" };
  const bots = await createCryptoBotGateway(principal, repo, () => NOW).getBybitBots();
  assert.equal(bots.total_bot_account_equity_usd, 200);
  assert.equal(bots.source.freshness_state, "stale");
});

test("decision explanation uses persisted reasons and does not invent rationale", async () => {
  const repo = new FakeRepository();
  const explanation = await createCryptoBotGateway(principal, repo, () => NOW).explainDecision("42");
  assert.deepEqual(explanation.rejection_reasons, ["VOLATILITY_TOO_HIGH"]);
  assert.match(explanation.explanation_he, /VOLATILITY_TOO_HIGH/);
  assert.equal(explanation.signal_evidence.some((item) => item.includes("regime=trend")), true);
  assert.equal(explanation.market_checks.spread_bps, 1.5);
});

test("unsafe exchange permission state escalates system to emergency stop", async () => {
  const repo = new FakeRepository();
  repo.connection = { ...repo.connection, trading_enabled: true };
  const health = await createCryptoBotGateway(principal, repo, () => NOW).getSystemHealth();
  assert.equal(health.overall_state, "emergency_stop");
  assert.equal(health.exchange_trading_enabled, true);
});
