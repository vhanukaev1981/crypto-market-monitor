import { createClient } from "npm:@supabase/supabase-js@2.55.0";

export type Principal = { userId: string; email: string | null };
type Row = Record<string, any>;
type AlgoV2Meta = {
  id: string;
  name: string;
  status: string;
  updated_at: string | null;
  head_sha: string | null;
  live_trading: false;
  leverage: false;
  pr_number: 7;
  source_url: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALGO_V2_PR_URL = "https://api.github.com/repos/vhanukaev1981/crypto-market-monitor/pulls/7";
const ALGO_V2_HTML_URL = "https://github.com/vhanukaev1981/crypto-market-monitor/pull/7";

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) throw new Error("supabase_runtime_secrets_missing");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const authClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let algoCache: { expiresAt: number; value: AlgoV2Meta | null } | null = null;

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

function freshness(observedAt: string | null, freshSeconds: number, staleSeconds: number, sourceState?: string) {
  if (!observedAt) return { observed_at: null, age_seconds: null, freshness_state: "unavailable", source_state: sourceState ?? "unknown" };
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(observedAt).getTime()) / 1000));
  const freshnessState = ageSeconds <= freshSeconds ? "fresh" : ageSeconds <= staleSeconds ? "aging" : "stale";
  return {
    observed_at: observedAt,
    age_seconds: ageSeconds,
    freshness_state: freshnessState,
    source_state: sourceState ?? (freshnessState === "stale" ? "attention" : "ok"),
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

async function getLegacyRuntime(userId: string) {
  const { data, error } = await admin
    .from("bot_configs")
    .select("name,status,enabled,kill_switch,last_run_at,updated_at,risk,environment")
    .eq("user_id", userId)
    .eq("environment", "mainnet")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { data: (data as Row | null) ?? null, error: error?.message ?? null };
}

function legacyStopped(row: Row | null) {
  return Boolean(row && (row.enabled === false || row.status === "stopped" || row.kill_switch === true));
}

async function getAlgoV2Meta(): Promise<AlgoV2Meta | null> {
  const now = Date.now();
  if (algoCache && algoCache.expiresAt > now) return algoCache.value;
  try {
    const response = await fetch(ALGO_V2_PR_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "CryptoBot-Control-Center" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`github_pr_http_${response.status}`);
    const payload = await response.json() as Row;
    const value: AlgoV2Meta = {
      id: "algo-v2-core-v1",
      name: text(payload.title) ?? "ALGO V2 Core V1",
      status: payload.draft === true ? "draft" : text(payload.state) ?? "unknown",
      updated_at: iso(payload.updated_at),
      head_sha: text(payload.head?.sha),
      live_trading: false,
      leverage: false,
      pr_number: 7,
      source_url: text(payload.html_url) ?? ALGO_V2_HTML_URL,
    };
    algoCache = { value, expiresAt: now + 60_000 };
    return value;
  } catch {
    algoCache = { value: null, expiresAt: now + 30_000 };
    return null;
  }
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

export async function getAlgoBotStatus(userId: string) {
  const [research, legacy] = await Promise.all([getAlgoV2Meta(), getLegacyRuntime(userId)]);
  if (research) {
    return {
      strategies: [{
        id: research.id,
        key: research.id,
        name: research.name,
        mode: "research",
        status: `${research.status} · no live · no leverage`,
        win_rate_pct: null,
        expectancy_usd: null,
        pnl_usd: null,
        drawdown_pct: null,
        trade_count: null,
        latest_signal: null,
        latest_decision_id: null,
        observed_at: research.updated_at,
        head_sha: research.head_sha,
        pr_number: research.pr_number,
      }],
      latest_signals: [],
      latest_decisions: [],
      live_trading: false,
      leverage: false,
      research: research,
      legacy_runtime: legacy.data ? {
        name: text(legacy.data.name),
        status: text(legacy.data.status),
        enabled: legacy.data.enabled === true,
        kill_switch: legacy.data.kill_switch === true,
        observed_at: iso(legacy.data.last_run_at ?? legacy.data.updated_at),
      } : null,
      source: freshness(research.updated_at, 21_600, 86_400),
    };
  }

  const observedAt = iso(legacy.data?.last_run_at ?? legacy.data?.updated_at);
  return {
    strategies: [],
    latest_signals: [],
    latest_decisions: [],
    live_trading: false,
    leverage: false,
    research: null,
    legacy_runtime: legacy.data ? {
      name: text(legacy.data.name), status: text(legacy.data.status), enabled: legacy.data.enabled === true,
      kill_switch: legacy.data.kill_switch === true, observed_at: observedAt,
    } : null,
    source: freshness(observedAt, 21_600, 86_400, legacy.error ? "fault" : "attention"),
  };
}

export async function getSystemHealth(userId: string) {
  const [snapshot, connection, stream, orderbook, legacy, research] = await Promise.all([
    one("bybit_demo_live_snapshot", userId, "checked_at,source,last_error,account"),
    admin.from("exchange_connections").select("status,last_error,last_checked_at,is_read_only,trading_enabled,withdrawals_enabled,connector_version,environment").eq("user_id", userId).eq("exchange", "bybit").eq("environment", "mainnet").maybeSingle(),
    many("bot_stream_state", userId, "connected,auth_ok,subscribed,last_message_at,last_error,updated_at", "updated_at", 1),
    many("bot_orderbook_stream_state", userId, "connected,last_sample_at,last_error,updated_at,symbol", "updated_at", 1),
    getLegacyRuntime(userId),
    getAlgoV2Meta(),
  ]);

  const checkedAt = iso(snapshot.data?.checked_at);
  const bybitMeta = freshness(checkedAt, 75, 180);
  const connectionRow = connection.data as Row | null;
  const connectionSafe = Boolean(connectionRow?.is_read_only) && connectionRow?.trading_enabled === false && connectionRow?.withdrawals_enabled === false;
  const bybitOk = snapshot.error === null && snapshot.data?.last_error == null && bybitMeta.freshness_state !== "stale" && connectionSafe;
  const stopped = legacyStopped(legacy.data);
  const researchMeta = freshness(research?.updated_at ?? null, 21_600, 86_400, research ? undefined : "attention");
  const legacyMeta = freshness(iso(legacy.data?.last_run_at ?? legacy.data?.updated_at), 60, 300, stopped ? "attention" : legacy.error ? "fault" : "unknown");
  const inactiveMeta = { observed_at: null, age_seconds: null, freshness_state: "unavailable", source_state: "unknown" };

  let overall = "healthy";
  if (!connectionSafe) overall = "emergency_stop";
  else if (!bybitOk) overall = "limited";
  else if (stopped) overall = "protection";
  else overall = "limited";

  return {
    overall_state: overall,
    components: [
      { key: "bybit_snapshot", label: "Bybit Mainnet Snapshot", state: bybitOk ? "ok" : "attention", message: snapshot.error ?? text(snapshot.data?.last_error), meta: bybitMeta },
      { key: "bybit_permissions", label: "Bybit Mainnet API — Read-Only", state: connectionSafe ? "ok" : "attention", message: connectionSafe ? "Read-only; trading and withdrawals disabled" : "Permission boundary requires attention", meta: freshness(iso(connectionRow?.last_checked_at), 180, 600) },
      { key: "algo_v2", label: "ALGO V2 Development", state: research ? "ok" : "attention", message: research ? `${research.status} · No Live · No Leverage · ${research.head_sha?.slice(0, 8) ?? "HEAD unavailable"}` : "PR #7 metadata unavailable", meta: researchMeta },
      { key: "legacy_algobot", label: "Legacy AlgoBot Runtime", state: stopped ? "attention" : "fault", message: stopped ? "Stopped safely; kill switch/protection state retained" : "Legacy runtime is not expected to be active", meta: legacyMeta },
      { key: "private_stream", label: "Private Stream", state: stopped ? "unknown" : "attention", message: stopped ? "Inactive while legacy runtime is stopped safely" : text(stream.data[0]?.last_error), meta: stopped ? inactiveMeta : freshness(iso(stream.data[0]?.last_message_at ?? stream.data[0]?.updated_at), 60, 300) },
      { key: "orderbook_stream", label: "Orderbook Stream", state: stopped ? "unknown" : "attention", message: stopped ? "Inactive while legacy runtime is stopped safely" : text(orderbook.data[0]?.last_error), meta: stopped ? inactiveMeta : freshness(iso(orderbook.data[0]?.last_sample_at ?? orderbook.data[0]?.updated_at), 60, 300) },
    ],
    authorization_mode: "read_only",
    exchange_trading_enabled: false,
    withdrawals_enabled: false,
    active_sources: {
      bybit_snapshot: bybitMeta,
      bybit_permissions: freshness(iso(connectionRow?.last_checked_at), 180, 600),
      algo_v2_code: researchMeta,
    },
    source: bybitMeta,
  };
}

export async function getBybitBots(userId: string) {
  const snapshot = await one("bybit_demo_live_snapshot", userId, "account,checked_at,last_error");
  const account = snapshot.data?.account as Row | null;
  const categories = detectedBotCategories(account);
  const bots = categories.map((row, index) => {
    const category = String(row.category);
    const kind = category.includes("Grid") ? "spot_grid" : category.includes("DCA") ? "dca" : "other";
    return {
      id: `bybit-${category.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${index}`,
      kind,
      symbol: kind === "spot_grid" ? "ETHUSDT" : null,
      status: "detected",
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
    details_status: bots.length ? "Bot allocations detected from Bybit asset-overview; performance fields remain unavailable unless verified." : "Individual bot detail is unavailable from the verified read-only source.",
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
    assets_scope: "unified_only",
    assets: assetsRaw.filter((row: Row) => (num(row.usd_value) ?? 0) > 0.00001).map((row: Row) => ({
      coin: String(row.coin ?? "UNKNOWN"), quantity: num(row.equity ?? row.wallet_balance), usd_value: num(row.usd_value), account_type: "Unified",
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
  const [legacy, research] = await Promise.all([getLegacyRuntime(userId), getAlgoV2Meta()]);
  const stopped = legacyStopped(legacy.data);
  return {
    daily_loss_pct: null,
    daily_loss_limit_pct: null,
    daily_loss_usd: null,
    max_daily_loss_usd: null,
    drawdown_pct: null,
    max_drawdown_pct: 5,
    exposure_usd: null,
    max_exposure_usd: null,
    max_usd_per_trade: null,
    open_positions: null,
    max_open_positions: null,
    kill_switch: legacy.data ? legacy.data.kill_switch === true : null,
    native_protection_required: true,
    reconciliation_state: stopped ? "unknown" : "attention",
    recent_events: [],
    live_trading: false,
    leverage: false,
    entry_allocation_cap_pct: 25,
    emergency_continuous_exposure_cap_pct: 30,
    policy_source: "ALGO V2 PR #7",
    legacy_history_available: Boolean(legacy.data),
    source: freshness(research?.updated_at ?? iso(legacy.data?.updated_at), 21_600, 86_400, research ? "ok" : "attention"),
  };
}

export async function getDashboardOverview(userId: string) {
  const [snapshot, algobot, bybitBots, risk, system] = await Promise.all([
    one("bybit_demo_live_snapshot", userId, "account,checked_at,source,last_error,linear_positions,spot_open_orders,linear_open_orders"),
    getAlgoBotStatus(userId),
    getBybitBots(userId),
    getRiskStatus(userId),
    getSystemHealth(userId),
  ]);
  const account = snapshot.data?.account as Row | null;
  const positions = Array.isArray(snapshot.data?.linear_positions) ? snapshot.data.linear_positions : [];
  const sourceAt = iso(snapshot.data?.checked_at);
  const researchSource = algobot.source;
  return {
    portfolio_equity_usd: num(account?.total_assets_usd),
    pnl: { day_usd: null, week_usd: null, month_usd: null },
    drawdown_pct: null,
    deployed_capital_pct: null,
    open_positions: positions.length,
    algobot: { active_strategies: 0, pnl_usd: null, mode_summary: { research: algobot.strategies.length } },
    bybit_bots: { count: bybitBots.bots.length || null, equity_usd: bybitBots.total_bot_account_equity_usd, pnl_usd: null },
    latest_decision: null,
    alerts: [],
    system_state: system.overall_state,
    sources: { bybit: freshness(sourceAt, 75, 180), algobot: researchSource, risk: risk.source, system: system.source },
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
    historical: true,
  };
}

export async function getControlCenterBootstrap(userId: string) {
  const [overview, algobot, bybit_bots, portfolio, risk, system] = await Promise.all([
    getDashboardOverview(userId), getAlgoBotStatus(userId), getBybitBots(userId), getPortfolio(userId), getRiskStatus(userId), getSystemHealth(userId),
  ]);
  return { overview, algobot, bybit_bots, portfolio, risk, system };
}
