import { z } from "zod";

export const FreshnessStateSchema = z.enum(["fresh", "aging", "stale", "unavailable"]);
export type FreshnessState = z.infer<typeof FreshnessStateSchema>;

export const SourceStateSchema = z.enum(["ok", "attention", "fault", "unknown"]);
export type SourceState = z.infer<typeof SourceStateSchema>;

export const SystemStateSchema = z.enum(["healthy", "limited", "protection", "emergency_stop"]);
export type SystemState = z.infer<typeof SystemStateSchema>;

export const SourceMetaSchema = z.object({
  observed_at: z.string().datetime().nullable(),
  age_seconds: z.number().nonnegative().nullable(),
  freshness_state: FreshnessStateSchema,
  source_state: SourceStateSchema,
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

const NullableNumber = z.number().finite().nullable();
const NullableString = z.string().nullable();

export const PnlWindowSchema = z.object({
  day_usd: NullableNumber,
  week_usd: NullableNumber,
  month_usd: NullableNumber,
});

export const AlertSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  message: z.string(),
  observed_at: z.string().datetime().nullable(),
  source: z.string(),
});

export const DecisionSummarySchema = z.object({
  id: z.string(),
  strategy: NullableString,
  symbol: NullableString,
  direction: NullableString,
  decision: z.string(),
  reason: NullableString,
  observed_at: z.string().datetime().nullable(),
});

export const DashboardOverviewSchema = z.object({
  portfolio_equity_usd: NullableNumber,
  pnl: PnlWindowSchema,
  drawdown_pct: NullableNumber,
  deployed_capital_pct: NullableNumber,
  open_positions: z.number().int().nonnegative().nullable(),
  algobot: z.object({
    active_strategies: z.number().int().nonnegative().nullable(),
    pnl_usd: NullableNumber,
    mode_summary: z.record(z.string(), z.number().int().nonnegative()),
  }),
  bybit_bots: z.object({
    count: z.number().int().nonnegative().nullable(),
    equity_usd: NullableNumber,
    pnl_usd: NullableNumber,
  }),
  latest_decision: DecisionSummarySchema.nullable(),
  alerts: z.array(AlertSchema),
  system_state: SystemStateSchema,
  sources: z.record(z.string(), SourceMetaSchema),
});
export type DashboardOverview = z.infer<typeof DashboardOverviewSchema>;

export const AlgoStrategySchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  mode: z.enum(["paper", "shadow", "demo", "live", "research", "unknown"]),
  status: z.string(),
  win_rate_pct: NullableNumber,
  expectancy_usd: NullableNumber,
  pnl_usd: NullableNumber,
  drawdown_pct: NullableNumber,
  trade_count: z.number().int().nonnegative().nullable(),
  latest_signal: NullableString,
  latest_decision_id: NullableString,
  observed_at: z.string().datetime().nullable(),
});

export const AlgoBotStatusSchema = z.object({
  strategies: z.array(AlgoStrategySchema),
  latest_signals: z.array(z.object({
    id: z.string(),
    strategy: NullableString,
    symbol: z.string(),
    signal: z.string(),
    confidence: NullableNumber,
    reason: NullableString,
    observed_at: z.string().datetime().nullable(),
  })),
  latest_decisions: z.array(DecisionSummarySchema),
  source: SourceMetaSchema,
});
export type AlgoBotStatus = z.infer<typeof AlgoBotStatusSchema>;

export const BybitBotSchema = z.object({
  id: z.string(),
  kind: z.enum(["spot_grid", "dca", "other"]),
  symbol: NullableString,
  status: z.enum(["running", "paused", "stopped", "unknown"]),
  invested_usd: NullableNumber,
  equity_usd: NullableNumber,
  total_pnl_usd: NullableNumber,
  total_pnl_pct: NullableNumber,
  grid_profit_usd: NullableNumber,
  range_low: NullableNumber,
  range_high: NullableNumber,
  grid_count: z.number().int().nonnegative().nullable(),
  observed_at: z.string().datetime().nullable(),
});

export const BybitBotsOutputSchema = z.object({
  bots: z.array(BybitBotSchema),
  total_bot_account_equity_usd: NullableNumber,
  details_available: z.boolean(),
  details_status: z.string(),
  source: SourceMetaSchema,
});
export type BybitBotsOutput = z.infer<typeof BybitBotsOutputSchema>;

export const PortfolioAssetSchema = z.object({
  coin: z.string(),
  quantity: NullableNumber,
  usd_value: NullableNumber,
  account_type: NullableString,
});

export const PortfolioPositionSchema = z.object({
  id: z.string(),
  market: z.string(),
  symbol: z.string(),
  side: z.string(),
  quantity: NullableNumber,
  entry_price: NullableNumber,
  current_price: NullableNumber,
  notional_usd: NullableNumber,
  unrealized_pnl_usd: NullableNumber,
  realized_pnl_usd: NullableNumber,
  stop_loss_price: NullableNumber,
  take_profit_price: NullableNumber,
  leverage: NullableNumber,
  protection_status: NullableString,
  strategy_key: NullableString,
  opened_at: z.string().datetime().nullable(),
});

export const PortfolioTradeSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: z.string(),
  quantity: NullableNumber,
  price: NullableNumber,
  fee_usd: NullableNumber,
  realized_pnl_usd: NullableNumber,
  executed_at: z.string().datetime().nullable(),
});

export const PortfolioOutputSchema = z.object({
  total_equity_usd: NullableNumber,
  account_breakdown: z.array(z.object({
    account_type: z.string(),
    usd_value: NullableNumber,
  })),
  assets: z.array(PortfolioAssetSchema),
  positions: z.array(PortfolioPositionSchema),
  recent_trades: z.array(PortfolioTradeSchema),
  source: SourceMetaSchema,
});
export type PortfolioOutput = z.infer<typeof PortfolioOutputSchema>;

export const RiskStatusSchema = z.object({
  daily_loss_pct: NullableNumber,
  daily_loss_limit_pct: NullableNumber,
  drawdown_pct: NullableNumber,
  max_drawdown_pct: NullableNumber,
  exposure_usd: NullableNumber,
  max_exposure_usd: NullableNumber,
  open_positions: z.number().int().nonnegative().nullable(),
  max_open_positions: z.number().int().nonnegative().nullable(),
  kill_switch: z.boolean().nullable(),
  native_protection_required: z.boolean().nullable(),
  reconciliation_state: z.enum(["synced", "attention", "mismatch", "unknown"]),
  recent_events: z.array(AlertSchema),
  source: SourceMetaSchema,
});
export type RiskStatus = z.infer<typeof RiskStatusSchema>;

export const HealthComponentSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: SourceStateSchema,
  message: NullableString,
  meta: SourceMetaSchema,
});

export const SystemHealthSchema = z.object({
  overall_state: SystemStateSchema,
  components: z.array(HealthComponentSchema),
  authorization_mode: z.literal("read_only"),
  exchange_trading_enabled: z.boolean(),
  withdrawals_enabled: z.boolean(),
  source: SourceMetaSchema,
});
export type SystemHealth = z.infer<typeof SystemHealthSchema>;

export const DecisionExplanationSchema = z.object({
  decision_id: z.string(),
  strategy: NullableString,
  symbol: NullableString,
  direction: NullableString,
  signal: NullableString,
  signal_evidence: z.array(z.string()),
  risk_checks: z.array(z.object({
    name: z.string(),
    state: z.enum(["passed", "failed", "unknown"]),
    detail: NullableString,
  })),
  market_checks: z.object({
    spread_bps: NullableNumber,
    estimated_slippage_bps: NullableNumber,
    expected_net_edge_bps: NullableNumber,
  }),
  final_decision: z.string(),
  rejection_reasons: z.array(z.string()),
  explanation_he: z.string(),
  observed_at: z.string().datetime().nullable(),
  source: SourceMetaSchema,
});
export type DecisionExplanation = z.infer<typeof DecisionExplanationSchema>;

export const ControlCenterBootstrapSchema = z.object({
  overview: DashboardOverviewSchema,
  algobot: AlgoBotStatusSchema.optional(),
  bybit_bots: BybitBotsOutputSchema.optional(),
  portfolio: PortfolioOutputSchema.optional(),
  risk: RiskStatusSchema.optional(),
  system: SystemHealthSchema.optional(),
});
export type ControlCenterBootstrap = z.infer<typeof ControlCenterBootstrapSchema>;
