import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.55.0";

export type Principal = { userId: string; email: string | null };

type Row = Record<string, any>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("supabase_runtime_secrets_missing");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const authClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function freshness(observedAt: string | null, freshSeconds: number, staleSeconds: number) {
  if (!observedAt) {
    return { observed_at: null, age_seconds: null, freshness_state: "unavailable", source_state: "unknown" };
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(observedAt).getTime()) / 1000));
  const freshnessState = ageSeconds <= freshSeconds ? "fresh" : ageSeconds <= staleSeconds ? "aging" : "stale";
  return {
    observed_at: observedAt,
    age_seconds: ageSeconds,
    freshness_state: freshnessState,
    source_state: freshnessState === "stale" ? "attention" : "ok",
  };
}

function botEquityFromAccount(account: Row | null): number | null {
  const breakdown = Array.isArray(account?.account_type_breakdown) ? account.account_type_breakdown : [];
  const row = breakdown.find((item: Row) => item?.type === "ACCOUNT_TYPE_BOT");
  return num(row?.usd_value);
}

function detectedBotCategories(account: Row | null) {
  const eth = Array.isArray(account?.eth_breakdown) ? account.eth_breakdown : [];
  const rows = eth.filter((item: Row) => item?.account_type === "TradingBot" && text(item?.category));
  const unique = new Map<string, Row>();
  for (const row of rows) unique.set(String(row.category), row);
  return [...unique.values()];
}

function alerts(rows: Row[]) {
  return rows.map((row) => ({
    id: String(row.id ?? crypto.randomUUID()),
    severity: row.severity === "critical" || row.severity === "error" ? "critical" : row.severity === "warning" || row.severity === "warn" ? "warning" : "info",
    title: text(row.code) ?? "אירוע מערכת",
    message: text(row.message) ?? "נרשם אירוע ללא תיאור מפורט",
    observed_at: iso(row.created_at),
    source: "risk_events",
  }));
}

async function one(table: string, userId: string, select = "*") {
  const { data, error } = await admin.from(table).select(select).eq("user_id", userId).maybeSingle();
  if (error) return { data: null as Row | null, error: error.message };
  return { data: (data as Row | null) ?? null, error: null as string | null };
}

async function many(table: string, userId: string, select = "*", orderBy?: string, limit?: number) {
  let query = admin.from(table).select(select).eq("user_id", userId);
  if (orderBy) query = query.order(orderBy, { ascending: false });
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  if (error) return { data: [] as Row[], error: error.message };
  return { data: (data as Row[] | null) ?? [], error: null as string | null };
}

export async function authenticateBearer(token: string): Promise<Principal | null> {
  const { data, error } = await authClient.auth.getUser(token);
  const user = data.user;
  if (error || !user?.id) return null;

  const { data: access, error: accessError } = await admin
    .from("cryptobot_mcp_access")
    .select("enabled")
    .eq("user_id", user.id)
    .maybeSingle();

  if (accessError || !access?.enabled) return null;
  return { userId: user.id, email: user.email ?? null };
}

export function authServerUrl() {
  return `${SUPABASE_URL}/auth/v1`;
}

export async function getSystemHealth(userId: string) {
  const [snapshot, connection, stream, orderbook, bots] = await Promise.all([
    one("bybit_demo_live_snapshot", userId, "checked_at,source,last_error,account"),
    admin.from("exchange_connections").select("status,last_error,last_checked_at,is_read_only,trading_enabled,withdrawals_enabled,connector_version,environment").eq("user_id", userId).eq("exchange", "bybit").eq("environment", "mainnet").maybeSingle(),
    many("bot_stream_state", userId, "connected,auth_ok,subscribed,last_message_at,last_error,updated_at", "updated_at", 1),
    many("bot_orderbook_stream_state", userId, "connected,last_sample_at,last_error,updated_at,symbol", "updated_at", 1),
    many("trading_bot_status", userId, "status,enabled,kill_switch,last_run_at,updated_at"),
  ]);

  const checkedAt = iso(snapshot.data?.checked_at);
  const bybitMeta = freshness(checkedAt, 75, 180);
  const connectionRow = connection.data as Row | null;
  const streamRow = stream.data[0] ?? null;
  const orderbookRow = orderbook.data[0] ?? null;
  const latestAlgoAt = bots.data.map((row) => iso(row.updated_at) ?? iso(row.last_run_at)).filter(Boolean).sort().reverse()[0] ?? null;
  const algoMeta = freshness(latestAlgoAt, 60, 300);

  const connectionSafe = Boolean(connectionRow?.is_read_only) && connectionRow?.trading_enabled === false && connectionRow?.withdrawals_enabled === false;
  const bybitOk = snapshot.error === null && snapshot.data?.last_error == null && bybitMeta.freshness_state !== "stale" && connectionSafe;
  const algoStoppedIntentionally = bots.data.length > 0 && bots.data.every((row) => row.enabled === false || row.status === "stopped");
  const algoHealthyEnough = algoStoppedIntentionally || algoMeta.freshness_state !== "stale";
  const overall = !connectionSafe ? "protection" : !bybitOk ? "limited" : !algoHealthyEnough ? "limited" : "healthy";

  const component = (key: string, label: string, ok: boolean, message: string | null, meta: any) => ({
    key, label, state: ok ? "ok" : "attention", message, meta,
  });

  return {
    overall_state: overall,
    components: [
      component("bybit_snapshot", "Bybit Mainnet Snapshot", bybitOk, snapshot.error ?? text(snapshot.data?.last_error), bybitMeta),
      component("bybit_permissions", "Bybit Read-Only Boundary", connectionSafe, connectionSafe ? "Read-only; trading and withdrawals disabled" : "Permission boundary requires attention", freshness(iso(connectionRow?.last_checked_at), 180, 600)),
      component("algobot", "AlgoBot", algoHealthyEnough, algoStoppedIntentionally ? "Stopped by current safety state" : null, algoMeta),
      component("private_stream", "Private Stream", Boolean(streamRow?.connected && streamRow?.auth_ok), text(streamRow?.last_error), freshness(iso(streamRow?.last_message_at ?? streamRow?.updated_at), 60, 300)),
      component("orderbook_stream", "Orderbook Stream", Boolean(orderbookRow?.connected), text(orderbookRow?.last_error), freshness(iso(orderbookRow?.last_sample_at ?? orderbookRow?.updated_at), 60, 300)),
    ],
    authorization_mode: "read_only",
    exchange_trading_enabled: Boolean(connectionRow?.trading_enabled),
    withdrawals_enabled: Boolean(connectionRow?.withdrawals_enabled),
    source: bybitMeta,
  };
}

export async function getDashboardOverview(userId: string) {
  const [snapshot, dashboard, decisions, riskRows, botStatuses, performance, system] = await Promise.all([
    one("bybit_demo_live_snapshot", userId, "account,checked_at,source,last_error"),
    one("trading_dashboard_summary", userId, "*"),
    many("strategy_decisions_v3", userId, "id,symbol,strategy_key,signal,eligible,rejection_codes,metadata,created_at", "created_at", 1),
    many("risk_events", userId, "id,severity,code,message,created_at", "created_at", 5),
    many("trading_bot_status", userId, "status,enabled,kill_switch,updated_at,strategy"),
    many("strategy_performance", userId, "strategy_key,net_pnl,updated_at"),
    getSystemHealth(userId),
  ]);

  const account = snapshot.data?.account as Row | null;
  const decision = decisions.data[0] ?? null;
  const rejection = Array.isArray(decision?.rejection_codes) ? decision.rejection_codes.map(String) : [];
  const reason = text(decision?.metadata?.decision?.reason) ?? (rejection.length ? rejection.join(", ") : null);
  const referenceCapital = num(dashboard.data?.reference_capital_usdt);
  const exposure = num(dashboard.data?.open_exposure_usdt);
  const deployed = referenceCapital && exposure !== null ? (exposure / referenceCapital) * 100 : exposure === 0 ? 0 : null;
  const strategies = botStatuses.data.flatMap((row) => Array.isArray(row.strategy?.strategies) ? row.strategy.strategies : []);
  const uniqueStrategies = new Set(strategies.map(String));
  const algoPnl = performance.data.map((row) => num(row.net_pnl)).filter((x): x is number => x !== null).reduce((a, b) => a + b, 0);
  const botCats = detectedBotCategories(account);
  const sourceAt = iso(snapshot.data?.checked_at);

  return {
    portfolio_equity_usd: num(account?.total_assets_usd) ?? num(dashboard.data?.account_equity_usdt),
    pnl: {
      day_usd: num(dashboard.data?.realized_today),
      week_usd: null,
      month_usd: null,
    },
    drawdown_pct: null,
    deployed_capital_pct: deployed,
    open_positions: num(dashboard.data?.open_positions),
    algobot: {
      active_strategies: uniqueStrategies.size || null,
      pnl_usd: performance.data.length ? algoPnl : null,
      mode_summary: botStatuses.data.reduce((acc: Record<string, number>, row) => {
        const key = text(row.strategy?.mode) ?? text(row.status) ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
    bybit_bots: {
      count: botCats.length || null,
      equity_usd: botEquityFromAccount(account),
      pnl_usd: null,
    },
    latest_decision: decision ? {
      id: String(decision.id),
      strategy: text(decision.strategy_key),
      symbol: text(decision.symbol),
      direction: null,
      decision: decision.eligible ? text(decision.signal) ?? "eligible" : text(decision.signal) === "hold" ? "HOLD / נדחה" : "נדחה",
      reason,
      observed_at: iso(decision.created_at),
    } : null,
    alerts: alerts(riskRows.data),
    system_state: system.overall_state,
    sources: {
      bybit: freshness(sourceAt, 75, 180),
      algobot: freshness(iso(decision?.created_at), 60, 300),
      risk: freshness(iso(riskRows.data[0]?.created_at), 300, 3600),
    },
  };
}

export async function getAlgoBotStatus(userId: string) {
  const [statuses, performance, decisions] = await Promise.all([
    many("trading_bot_status", userId, "bot_id,name,status,enabled,kill_switch,last_run_at,updated_at,strategy"),
    many("strategy_performance", userId, "strategy_key,trades,wins,losses,net_pnl,expectancy_usdt,profit_factor,avg_return_pct,updated_at", "updated_at"),
    many("strategy_decisions_v3", userId, "id,symbol,strategy_key,signal,eligible,rejection_codes,score,metadata,created_at", "created_at", 50),
  ]);

  const perfByKey = new Map(performance.data.map((row) => [String(row.strategy_key), row]));
  const decisionByKey = new Map<string, Row>();
  for (const row of decisions.data) if (!decisionByKey.has(String(row.strategy_key))) decisionByKey.set(String(row.strategy_key), row);

  const keys = new Set<string>();
  for (const row of statuses.data) for (const key of Array.isArray(row.strategy?.strategies) ? row.strategy.strategies : []) keys.add(String(key));
  for (const row of performance.data) keys.add(String(row.strategy_key));
  for (const row of decisions.data) keys.add(String(row.strategy_key));

  const modeFrom = (row: Row | null) => {
    const raw = String(statuses.data[0]?.strategy?.mode ?? "").toLowerCase();
    if (row?.metadata?.shadow_only === true || raw.includes("shadow")) return "shadow";
    if (raw.includes("paper")) return "paper";
    if (raw.includes("demo")) return "demo";
    if (raw.includes("live") && statuses.data.some((x) => x.enabled === true && x.kill_switch === false)) return "live";
    return "research";
  };

  const strategies = [...keys].map((key) => {
    const perf = perfByKey.get(key) ?? null;
    const last = decisionByKey.get(key) ?? null;
    const wins = num(perf?.wins);
    const trades = num(perf?.trades);
    return {
      id: key,
      key,
      name: key.replaceAll("_", " "),
      mode: modeFrom(last),
      status: statuses.data[0]?.enabled ? text(statuses.data[0]?.status) ?? "enabled" : "stopped",
      win_rate_pct: wins !== null && trades ? (wins / trades) * 100 : null,
      expectancy_usd: num(perf?.expectancy_usdt),
      pnl_usd: num(perf?.net_pnl),
      drawdown_pct: null,
      trade_count: trades,
      latest_signal: text(last?.signal),
      latest_decision_id: last?.id != null ? String(last.id) : null,
      observed_at: iso(last?.created_at ?? perf?.updated_at),
    };
  });

  return {
    strategies,
    latest_signals: decisions.data.slice(0, 10).map((row) => ({
      id: String(row.id),
      strategy: text(row.strategy_key),
      symbol: text(row.symbol) ?? "UNKNOWN",
      signal: text(row.signal) ?? "unknown",
      confidence: num(row.metadata?.decision?.confidence),
      reason: text(row.metadata?.decision?.reason) ?? (Array.isArray(row.rejection_codes) ? row.rejection_codes.join(", ") : null),
      observed_at: iso(row.created_at),
    })),
    latest_decisions: decisions.data.slice(0, 10).map((row) => ({
      id: String(row.id),
      strategy: text(row.strategy_key),
      symbol: text(row.symbol),
      direction: null,
      decision: row.eligible ? text(row.signal) ?? "eligible" : text(row.signal) === "hold" ? "HOLD / נדחה" : "נדחה",
      reason: text(row.metadata?.decision?.reason) ?? (Array.isArray(row.rejection_codes) ? row.rejection_codes.join(", ") : null),
      observed_at: iso(row.created_at),
    })),
    source: freshness(iso(decisions.data[0]?.created_at), 60, 300),
  };
}

export async function getBybitBots(userId: string) {
  const snapshot = await one("bybit_demo_live_snapshot", userId, "account,checked_at,last_error");
  const account = snapshot.data?.account as Row | null;
  const categories = detectedBotCategories(account);
  const bots = categories.map((row, index) => {
    const category = String(row.category);
    return {
      id: `bybit-${category.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${index}`,
      kind: category.includes("Grid") ? "spot_grid" : category.includes("DCA") ? "dca" : "other",
      symbol: category.includes("Grid") ? "ETHUSDT" : null,
      status: "unknown",
      invested_usd: null,
      equity_usd: null,
      total_pnl_usd: null,
      total_pnl_pct: null,
      grid_profit_usd: null,
      range_low: null,
      range_high: null,
      grid_count: null,
      observed_at: iso(snapshot.data?.checked_at),
      observed_eth_quantity: num(row.quantity),
      category,
    };
  });

  return {
    bots,
    total_bot_account_equity_usd: botEquityFromAccount(account),
    details_available: bots.length > 0,
    details_status: bots.length ? "זוהתה הקצאת ETH לפי קטגוריית Bot; נתוני P&L/טווח/מספר גרידים אינם מומצאים ללא API מאומת." : "פירוט בוט בודד אינו זמין ממקור קריאה מאומת.",
    source: freshness(iso(snapshot.data?.checked_at), 75, 180),
  };
}

export async function getPortfolio(userId: string) {
  const [snapshot, positions, trades] = await Promise.all([
    one("bybit_demo_live_snapshot", userId, "account,assets,checked_at,last_error"),
    many("open_positions_unified", userId, "position_id,market,direction,symbol,qty,entry_price,current_price,notional_usdt,unrealized_pnl,stop_loss_price,take_profit_price,protection_status,strategy_key,opened_at", "opened_at", 50),
    many("executions", userId, "id,symbol,side,qty,price,fee_usdt,realized_pnl,executed_at", "executed_at", 50),
  ]);
  const account = snapshot.data?.account as Row | null;
  const assetsRaw = Array.isArray(snapshot.data?.assets) ? snapshot.data.assets : [];
  const breakdown = Array.isArray(account?.account_type_breakdown) ? account.account_type_breakdown : [];

  return {
    total_equity_usd: num(account?.total_assets_usd),
    account_breakdown: breakdown.filter((row: Row) => num(row.usd_value) !== 0).map((row: Row) => ({ account_type: String(row.type ?? "UNKNOWN"), usd_value: num(row.usd_value) })),
    assets: assetsRaw.filter((row: Row) => (num(row.usd_value) ?? 0) > 0.00001).map((row: Row) => ({
      coin: String(row.coin ?? "UNKNOWN"),
      quantity: num(row.equity ?? row.wallet_balance),
      usd_value: num(row.usd_value),
      account_type: "Unified",
    })),
    positions: positions.data.map((row) => ({
      id: String(row.position_id ?? crypto.randomUUID()), market: String(row.market ?? "unknown"), symbol: String(row.symbol ?? "UNKNOWN"), side: String(row.direction ?? "unknown"),
      quantity: num(row.qty), entry_price: num(row.entry_price), current_price: num(row.current_price), notional_usd: num(row.notional_usdt), unrealized_pnl_usd: num(row.unrealized_pnl), realized_pnl_usd: null,
      stop_loss_price: num(row.stop_loss_price), take_profit_price: num(row.take_profit_price), leverage: null, protection_status: text(row.protection_status), strategy_key: text(row.strategy_key), opened_at: iso(row.opened_at),
    })),
    recent_trades: trades.data.map((row) => ({ id: String(row.id), symbol: String(row.symbol ?? "UNKNOWN"), side: String(row.side ?? "unknown"), quantity: num(row.qty), price: num(row.price), fee_usd: num(row.fee_usdt), realized_pnl_usd: num(row.realized_pnl), executed_at: iso(row.executed_at) })),
    source: freshness(iso(snapshot.data?.checked_at), 75, 180),
  };
}

export async function getRiskStatus(userId: string) {
  const [dashboard, statuses, riskRows, stream] = await Promise.all([
    one("trading_dashboard_summary", userId, "*") ,
    many("trading_bot_status", userId, "risk,kill_switch,enabled,status,updated_at"),
    many("risk_events", userId, "id,severity,code,message,created_at", "created_at", 20),
    many("bot_stream_state", userId, "connected,auth_ok,subscribed,last_message_at,updated_at,last_error", "updated_at", 1),
  ]);
  const status = statuses.data[0] ?? null;
  const risk = status?.risk ?? {};
  const streamRow = stream.data[0] ?? null;
  const reconciliation = streamRow?.connected && streamRow?.auth_ok && streamRow?.subscribed ? "synced" : streamRow ? "attention" : "unknown";
  return {
    daily_loss_pct: null,
    daily_loss_limit_pct: null,
    daily_loss_usd: num(dashboard.data?.realized_today),
    max_daily_loss_usd: num(risk.max_daily_loss_usdt),
    drawdown_pct: null,
    max_drawdown_pct: null,
    exposure_usd: num(dashboard.data?.open_exposure_usdt),
    max_exposure_usd: null,
    max_usd_per_trade: num(risk.max_usdt_per_trade),
    open_positions: num(dashboard.data?.open_positions),
    max_open_positions: num(risk.max_open_positions),
    kill_switch: typeof status?.kill_switch === "boolean" ? status.kill_switch : null,
    native_protection_required: typeof risk.require_native_protection === "boolean" ? risk.require_native_protection : null,
    reconciliation_state: reconciliation,
    recent_events: alerts(riskRows.data),
    source: freshness(iso(status?.updated_at ?? streamRow?.updated_at), 60, 300),
  };
}

export async function explainDecision(userId: string, decisionId: string) {
  const { data, error } = await admin.from("strategy_decisions_v3")
    .select("id,symbol,strategy_key,signal,eligible,rejection_codes,spread_bps,estimated_slippage_bps,expected_net_edge_bps,metadata,created_at")
    .eq("user_id", userId).eq("id", decisionId).maybeSingle();
  if (error) throw new Error("decision_lookup_failed");
  if (!data) throw new Error("decision_not_found");
  const row = data as Row;
  const rejection = Array.isArray(row.rejection_codes) ? row.rejection_codes.map(String) : [];
  const recordedReason = text(row.metadata?.decision?.reason);
  const evidence = recordedReason ? [recordedReason] : rejection;
  const explanation = recordedReason ?? (rejection.length ? rejection.join(", ") : "לא נשמר נימוק מפורט");
  return {
    decision_id: String(row.id), strategy: text(row.strategy_key), symbol: text(row.symbol), direction: null, signal: text(row.signal),
    signal_evidence: evidence,
    risk_checks: rejection.map((code) => ({ name: code, state: "failed", detail: null })),
    market_checks: { spread_bps: num(row.spread_bps), estimated_slippage_bps: num(row.estimated_slippage_bps), expected_net_edge_bps: num(row.expected_net_edge_bps) },
    final_decision: row.eligible ? text(row.signal) ?? "eligible" : "rejected",
    rejection_reasons: rejection,
    explanation_he: explanation,
    observed_at: iso(row.created_at),
    source: freshness(iso(row.created_at), 60, 300),
  };
}

export async function getControlCenterBootstrap(userId: string) {
  const [overview, algobot, bybit_bots, portfolio, risk, system] = await Promise.all([
    getDashboardOverview(userId), getAlgoBotStatus(userId), getBybitBots(userId), getPortfolio(userId), getRiskStatus(userId), getSystemHealth(userId),
  ]);
  return { overview, algobot, bybit_bots, portfolio, risk, system };
}
