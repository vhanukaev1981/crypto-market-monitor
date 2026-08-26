import type { ScopedSupabase } from "./supabase.ts";
import type { CryptoBotRepository, RepoResult, Row } from "./repository.ts";

function result<T>(data: T, error: { message?: string } | null): RepoResult<T> {
  return { data, error: error?.message?.slice(0, 300) ?? null };
}

const decisionSelect = "id,run_id,bot_id,symbol,strategy_key,strategy_version,timeframe,candle_time,market_regime,regime_confidence,score,signal,eligible,rejection_codes,expected_gross_edge_bps,estimated_fee_bps,estimated_slippage_bps,expected_net_edge_bps,reward_risk_gross,reward_risk_net,spread_bps,metadata,created_at";

export function createSupabaseRepository(scoped: ScopedSupabase): CryptoBotRepository {
  const { client } = scoped;
  return {
    async getLiveSnapshot(userId) {
      const { data, error } = await client.from("bybit_demo_live_snapshot")
        .select("account,assets,linear_positions,prices,spot_open_orders,linear_open_orders,checked_at,source,last_error,updated_at")
        .eq("user_id", userId).maybeSingle();
      return result((data as Row | null) ?? null, error);
    },
    async getDashboardSummary(userId) {
      const { data, error } = await client.from("trading_dashboard_summary")
        .select("*").eq("user_id", userId).maybeSingle();
      return result((data as Row | null) ?? null, error);
    },
    async getAccountAssets(userId) {
      const { data, error } = await client.from("bybit_demo_account_assets")
        .select("coin,equity,wallet_balance,usd_value,locked,unrealized_pnl,cumulative_realized_pnl,managed_by_bot,asset_class,display_order,checked_at")
        .eq("user_id", userId).order("display_order", { ascending: true });
      return result((data as Row[] | null) ?? [], error);
    },
    async getOpenPositions(userId) {
      const { data, error } = await client.from("open_positions_unified")
        .select("position_id,bot_id,market,direction,symbol,status,qty,entry_price,current_price,notional_usdt,unrealized_pnl,stop_loss_price,take_profit_price,protection_status,strategy_key,opened_at,updated_at")
        .eq("user_id", userId).order("opened_at", { ascending: false });
      return result((data as Row[] | null) ?? [], error);
    },
    async getExecutions(userId) {
      const { data, error } = await client.from("executions")
        .select("id,symbol,side,qty,price,fee_usdt,realized_pnl,executed_at")
        .eq("user_id", userId).order("executed_at", { ascending: false }).limit(50);
      return result((data as Row[] | null) ?? [], error);
    },
    async getBotStatuses(userId) {
      const { data, error } = await client.from("trading_bot_status")
        .select("bot_id,name,environment,category,status,enabled,kill_switch,last_run_at,updated_at,risk,strategy")
        .eq("user_id", userId);
      return result((data as Row[] | null) ?? [], error);
    },
    async getStrategyPerformance(userId) {
      const { data, error } = await client.from("strategy_performance")
        .select("strategy_key,trades,wins,losses,net_pnl,expectancy_usdt,profit_factor,avg_return_pct,updated_at")
        .eq("user_id", userId).order("updated_at", { ascending: false });
      return result((data as Row[] | null) ?? [], error);
    },
    async getStrategyDecisions(userId, limit = 50) {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const { data, error } = await client.from("strategy_decisions_v3")
        .select(decisionSelect)
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(safeLimit);
      return result((data as Row[] | null) ?? [], error);
    },
    async getStrategyDecision(userId, decisionId) {
      const numericId = Number(decisionId);
      if (!Number.isSafeInteger(numericId) || numericId < 1) return result<Row | null>(null, { message: "invalid_decision_id" });
      const { data, error } = await client.from("strategy_decisions_v3")
        .select(decisionSelect)
        .eq("user_id", userId).eq("id", numericId).maybeSingle();
      return result((data as Row | null) ?? null, error);
    },
    async getRiskEvents(userId, limit = 20) {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const { data, error } = await client.from("risk_events")
        .select("id,bot_id,severity,code,message,details,created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(safeLimit);
      return result((data as Row[] | null) ?? [], error);
    },
    async getExchangeConnection(userId) {
      const { data, error } = await client.from("exchange_connections")
        .select("status,last_error,last_checked_at,is_read_only,trading_enabled,withdrawals_enabled,connector_version,environment")
        .eq("user_id", userId).eq("exchange", "bybit").eq("environment", "mainnet").maybeSingle();
      return result((data as Row | null) ?? null, error);
    },
    async getStreamState(userId) {
      const { data, error } = await client.from("bot_stream_state")
        .select("connected,auth_ok,subscribed,events_received,reconnects,last_connected_at,last_disconnected_at,last_message_at,last_error,updated_at")
        .eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      return result((data as Row | null) ?? null, error);
    },
    async getOrderbookStreamState(userId) {
      const { data, error } = await client.from("bot_orderbook_stream_state")
        .select("connected,symbol,samples_written,messages_received,last_connected_at,last_disconnected_at,last_sample_at,last_error,updated_at")
        .eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      return result((data as Row | null) ?? null, error);
    },
  };
}
