import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  authenticateBearer,
  explainDecision,
  getAlgoBotStatus,
  getBybitBots,
  getControlCenterBootstrap,
  getDashboardOverview,
  getPortfolio,
  getRiskStatus,
  getSystemHealth,
  type Principal,
} from "https://raw.githubusercontent.com/vhanukaev1981/crypto-market-monitor/8504f8e63962030af579cf3bd75553152ed5f02d/crypto-market-monitor-full-source/supabase/functions/cryptobot-mcp/data.ts";
import {
  isStandalonePreviewTool,
  type StandalonePreviewTool,
} from "https://raw.githubusercontent.com/vhanukaev1981/crypto-market-monitor/8504f8e63962030af579cf3bd75553152ed5f02d/crypto-market-monitor-full-source/src/cryptobot/preview-contract.ts";

const CANONICAL_CONTROL_CENTER_SHA = "8504f8e63962030af579cf3bd75553152ed5f02d";
const ALLOWED_ORIGINS = new Set([
  "https://cryptobot-control-center.lovable.app",
  "https://id-preview--44c0e724-2c9d-4dc6-836d-3dcf91798569.lovable.app",
]);

type AnyObj = Record<string, any>;
const obj = (v: unknown): AnyObj => (v && typeof v === "object" && !Array.isArray(v) ? v as AnyObj : {});
const arr = (v: unknown): AnyObj[] => Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as AnyObj[] : [];
const observed = (source: unknown): string | null => {
  const s = obj(source);
  return typeof s.observed_at === "string" ? s.observed_at : null;
};
const sourceCompat = (source: unknown) => {
  const s = obj(source);
  return { ...s, updated_at: s.observed_at ?? null, timestamp: s.observed_at ?? null, last_update: s.observed_at ?? null };
};

// ALGO V2 is a research/code source, not a runtime heartbeat. Preserve its
// canonical 6h fresh / 24h stale policy so the Lovable client does not apply
// its generic 30-minute fallback to research metadata.
const researchSourceCompat = (source: unknown) => {
  const s = obj(source);
  const rawAge = typeof s.age_seconds === "number" && Number.isFinite(s.age_seconds)
    ? Math.max(0, s.age_seconds)
    : null;
  const ageSeconds = rawAge ?? (() => {
    const at = observed(s);
    if (!at) return null;
    const ms = new Date(at).getTime();
    return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 1000)) : null;
  })();

  let freshnessState = typeof s.freshness_state === "string" ? s.freshness_state : null;
  if (ageSeconds !== null) {
    freshnessState = ageSeconds <= 21_600 ? "fresh" : ageSeconds <= 86_400 ? "delayed" : "stale";
  } else if (freshnessState === "aging") {
    freshnessState = "delayed";
  }

  return {
    ...sourceCompat(s),
    age_seconds: ageSeconds,
    freshness_state: freshnessState,
  };
};

const sumKnown = (rows: AnyObj[], key: string): number | null => {
  const nums = rows.map((r) => r[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
};

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get("authorization") ?? "").trim());
  return match?.[1]?.trim() ?? null;
}

async function principalFor(request: Request): Promise<Principal | null> {
  const token = bearer(request);
  return token ? await authenticateBearer(token) : null;
}

async function runTool(principal: Principal, tool: StandalonePreviewTool, args: Record<string, unknown>) {
  switch (tool) {
    case "open_control_center": return await getControlCenterBootstrap(principal.userId);
    case "get_dashboard_overview": return await getDashboardOverview(principal.userId);
    case "get_algobot_status": return await getAlgoBotStatus(principal.userId);
    case "get_bybit_bots": return await getBybitBots(principal.userId);
    case "get_portfolio": return await getPortfolio(principal.userId);
    case "get_risk_status": return await getRiskStatus(principal.userId);
    case "get_system_health": return await getSystemHealth(principal.userId);
    case "explain_decision": {
      const decisionId = typeof args.decision_id === "string" ? args.decision_id : "";
      if (!/^\d{1,30}$/.test(decisionId)) throw new Error("invalid_decision_id");
      return await explainDecision(principal.userId, decisionId);
    }
  }
}

function compat(tool: StandalonePreviewTool, raw: unknown): unknown {
  const r = obj(raw);

  if (tool === "get_dashboard_overview") {
    const p = obj(r.pnl);
    const sources = Object.fromEntries(
      Object.entries(obj(r.sources)).map(([k, v]) => [
        k,
        k === "algobot" || k === "risk" ? researchSourceCompat(v) : sourceCompat(v),
      ]),
    );
    return {
      ...r,
      equity: r.portfolio_equity_usd ?? null,
      total_equity: r.portfolio_equity_usd ?? null,
      portfolio_value: r.portfolio_equity_usd ?? null,
      pnl: { ...p, daily: p.day_usd ?? null, weekly: p.week_usd ?? null, monthly: p.month_usd ?? null },
      drawdown: r.drawdown_pct ?? null,
      open_positions_count: r.open_positions ?? null,
      updated_at: observed(obj(r.sources).bybit) ?? observed(obj(r.sources).algobot) ?? null,
      sources,
    };
  }

  if (tool === "get_algobot_status") {
    const strategies = arr(r.strategies);
    const signals = arr(r.latest_signals);
    const last = signals[0] ?? null;
    const statuses = [...new Set(strategies.map((s) => s.status).filter((v) => typeof v === "string"))];
    const status = statuses.length === 1 ? statuses[0] : statuses.length > 1 ? "mixed" : null;
    const trades = sumKnown(strategies, "trade_count");
    const pnl = sumKnown(strategies, "pnl_usd");
    const winRate = strategies.length === 1 ? strategies[0]?.win_rate_pct ?? null : null;
    const strategyLabel = strategies.length === 1 ? strategies[0]?.name ?? strategies[0]?.key ?? null : strategies.length > 1 ? `${strategies.length} אסטרטגיות` : null;
    const latestDecision = last ? {
      id: last.id ?? null,
      action: last.signal ?? null,
      decision: last.signal ?? null,
      symbol: last.symbol ?? null,
      confidence: last.confidence ?? null,
      reason: last.reason ?? null,
      explanation: last.reason ?? null,
      timestamp: last.observed_at ?? null,
      created_at: last.observed_at ?? null,
      observed_at: last.observed_at ?? null,
    } : null;

    // Do not fabricate runtime stage health. ALGO V2 currently exposes
    // research/development metadata; the UI will render architecture-only
    // fallback stages when no verified runtime pipeline is returned.
    return {
      ...r,
      status,
      state: status,
      strategy: strategyLabel,
      strategy_name: strategyLabel,
      win_rate: winRate,
      trades_count: trades,
      total_trades: trades,
      pnl,
      total_pnl: pnl,
      updated_at: observed(r.source),
      latest_decision: latestDecision,
      latest_decision_id: latestDecision?.id ?? null,
      source: researchSourceCompat(r.source),
    };
  }

  if (tool === "get_bybit_bots") {
    const bots = arr(r.bots).map((b) => ({
      ...b,
      name: b.category ?? b.kind ?? b.id ?? null,
      bot_name: b.category ?? b.kind ?? b.id ?? null,
      type: b.kind ?? b.category ?? null,
      bot_type: b.kind ?? b.category ?? null,
      pnl: b.total_pnl_usd ?? null,
      total_pnl: b.total_pnl_usd ?? null,
      roi: b.total_pnl_pct ?? null,
      roi_pct: b.total_pnl_pct ?? null,
      details_available: false,
    }));
    return { ...r, bots, updated_at: observed(r.source), source: sourceCompat(r.source) };
  }

  if (tool === "get_portfolio") {
    const assets = arr(r.assets).map((a) => ({ ...a, amount: a.quantity ?? null, balance: a.quantity ?? null, qty: a.quantity ?? null }));
    const positions = arr(r.positions).map((p) => ({ ...p, qty: p.quantity ?? null, size: p.quantity ?? null, mark_price: p.current_price ?? null, unrealized_pnl: p.unrealized_pnl_usd ?? null, pnl: p.unrealized_pnl_usd ?? null }));
    const trades = arr(r.recent_trades).map((t) => ({ ...t, qty: t.quantity ?? null, realized_pnl: t.realized_pnl_usd ?? null, pnl: t.realized_pnl_usd ?? null, timestamp: t.executed_at ?? null, created_at: t.executed_at ?? null }));
    return {
      ...r,
      equity: r.total_equity_usd ?? null,
      total_equity: r.total_equity_usd ?? null,
      balances: assets,
      assets,
      positions,
      open_positions: positions,
      trades,
      recent_trades: trades,
      updated_at: observed(r.source),
      source: sourceCompat(r.source),
    };
  }

  if (tool === "get_risk_status") {
    const limits = {
      max_daily_loss_usd: r.max_daily_loss_usd ?? null,
      max_drawdown_pct: r.max_drawdown_pct ?? null,
      max_exposure_usd: r.max_exposure_usd ?? null,
      max_usd_per_trade: r.max_usd_per_trade ?? null,
      max_open_positions: r.max_open_positions ?? null,
      native_protection_required: r.native_protection_required ?? null,
    };
    return {
      ...r,
      exposure: r.exposure_usd ?? null,
      total_exposure: r.exposure_usd ?? null,
      drawdown: r.drawdown_pct ?? null,
      daily_loss: r.daily_loss_usd ?? null,
      limits,
      risk_limits: limits,
      violations: r.recent_events ?? [],
      alerts: r.recent_events ?? [],
      updated_at: observed(r.source),
      source: researchSourceCompat(r.source),
    };
  }

  if (tool === "get_system_health") {
    const components = arr(r.components).map((c) => ({
      ...c,
      name: c.label ?? c.key ?? null,
      service: c.label ?? c.key ?? null,
      status: c.state ?? null,
      health: c.state ?? null,
    }));

    for (const c of components) {
      if (c.key === "bybit_permissions") {
        c.label = "Bybit Mainnet API — Read-Only";
        c.name = "Bybit Mainnet API — Read-Only";
        c.service = "Bybit Mainnet API — Read-Only";
      }

      if (c.key === "algo_v2") {
        c.meta = researchSourceCompat(c.meta);
      }

      if (c.key === "legacy_algobot" && /stopped safely|kill switch|protection/i.test(String(c.message ?? ""))) {
        c.state = "inactive";
        c.status = "inactive";
        c.health = "inactive";
        c.meta = { ...obj(c.meta), observed_at: null, age_seconds: null, freshness_state: "inactive", source_state: "inactive" };
      }

      if (c.key === "private_stream" && /inactive/i.test(String(c.message ?? ""))) {
        c.state = "inactive";
        c.status = "inactive";
        c.health = "inactive";
        c.meta = { ...obj(c.meta), observed_at: null, age_seconds: null, freshness_state: "inactive", source_state: "inactive" };
      }

      if (c.key === "orderbook_stream" && /inactive/i.test(String(c.message ?? ""))) {
        c.state = "inactive";
        c.status = "inactive";
        c.health = "inactive";
        c.meta = { ...obj(c.meta), observed_at: null, age_seconds: null, freshness_state: "inactive", source_state: "inactive" };
      }
    }

    const dataSources = Object.fromEntries(components.map((c) => [
      String(c.key ?? c.name ?? "source"),
      c.key === "algo_v2" ? researchSourceCompat(c.meta) : sourceCompat(c.meta),
    ]));
    return {
      ...r,
      status: r.overall_state ?? null,
      overall: r.overall_state ?? null,
      health: r.overall_state ?? null,
      state: r.overall_state ?? null,
      components,
      services: components,
      data_sources: dataSources,
      sources: dataSources,
      updated_at: observed(r.source),
      checked_at: observed(r.source),
      source: sourceCompat(r.source),
    };
  }

  if (tool === "explain_decision") {
    const checks = arr(r.risk_checks).map((x) => ({ ...x, value: x.state ?? null, score: x.state ?? null }));
    return {
      ...r,
      explanation: r.explanation_he ?? null,
      summary: r.explanation_he ?? null,
      reason: r.explanation_he ?? null,
      factors: checks,
      timestamp: r.observed_at ?? null,
      created_at: r.observed_at ?? null,
      source: sourceCompat(r.source),
    };
  }

  return raw;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const headers = cors(origin);

  if (request.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403, headers });
    return new Response("ok", { status: 200, headers });
  }

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.endsWith("/health")) {
    return new Response(JSON.stringify({
      ok: true,
      service: "cryptobot-api",
      version: 6,
      mode: "private_read_only",
      allowed_tools: 8,
      cors_origins: ALLOWED_ORIGINS.size,
      compatibility: "lovable-v1-readonly",
      canonical_control_center_sha: CANONICAL_CONTROL_CENTER_SHA,
      bybit_credentials: "BYBIT_LIVE_API_KEY/BYBIT_LIVE_API_SECRET only",
      execution_api_probe: false,
    }), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...headers, "Content-Type": "application/json" } });
  }
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
  }

  const principal = await principalFor(request);
  if (!principal) {
    return new Response(JSON.stringify({ error: "authentication_required" }), { status: 401, headers: { ...headers, "Content-Type": "application/json" } });
  }

  let body: { name?: unknown; args?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }

  const name = typeof body.name === "string" ? body.name : "";
  if (!isStandalonePreviewTool(name)) {
    return new Response(JSON.stringify({ error: "tool_not_allowed" }), { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
  }

  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};

  try {
    const canonical = await runTool(principal, name, args);
    const data = compat(name, canonical);
    return new Response(JSON.stringify(data), { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "tool_failed";
    const status = message === "invalid_decision_id" ? 400 : 500;
    return new Response(JSON.stringify({ error: message }), { status, headers: { ...headers, "Content-Type": "application/json" } });
  }
});
