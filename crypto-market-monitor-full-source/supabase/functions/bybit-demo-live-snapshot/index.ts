import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const BASE_URL = "https://api-demo.bybit.com";
const RECV_WINDOW = "5000";
const CACHE_MS = 5000;

type Json = Record<string, unknown>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const admin = () => createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  { auth: { persistSession: false } },
);

function credentials() {
  const apiKey = Deno.env.get("BYBIT_DEMO_API_KEY")?.trim();
  const apiSecret = Deno.env.get("BYBIT_DEMO_API_SECRET")?.trim();
  if (!apiKey || !apiSecret) throw new Error("Bybit Demo credentials are not configured");
  if (Deno.env.get("BYBIT_ENV")?.trim().toLowerCase() !== "demo" || Deno.env.get("BYBIT_BASE_URL")?.trim() !== BASE_URL) {
    throw new Error("Snapshot access is locked to Bybit Demo");
  }
  return { apiKey, apiSecret };
}

async function hmacHex(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function bybitGet(path: string, params: Record<string, unknown> = {}) {
  if (!path.startsWith("/v5/") || path.includes("order/create") || path.includes("order/cancel")) throw new Error("Endpoint is not permitted");
  const { apiKey, apiSecret } = credentials();
  const timestamp = Date.now().toString();
  const query = new URLSearchParams();
  Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b)).forEach(([key, value]) => query.set(key, String(value)));
  const payload = query.toString();
  const signature = await hmacHex(apiSecret, timestamp + apiKey + RECV_WINDOW + payload);
  const response = await fetch(`${BASE_URL}${path}${payload ? `?${payload}` : ""}`, {
    method: "GET",
    headers: { "X-BAPI-API-KEY": apiKey, "X-BAPI-SIGN": signature, "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": RECV_WINDOW, Accept: "application/json" },
  });
  const data = await response.json().catch(() => ({ retCode: -1, retMsg: "Invalid JSON" }));
  if (!response.ok || data?.retCode !== 0) throw new Error(data?.retMsg || `Bybit HTTP ${response.status}`);
  return data.result;
}

const ageMs = (checkedAt: unknown) => checkedAt ? Date.now() - new Date(String(checkedAt)).getTime() : Number.POSITIVE_INFINITY;
const publicSnapshot = (row: Json, stale = false) => ({
  ok: true, stale, account: row.account || {}, assets: row.assets || [], linear_positions: row.linear_positions || [], prices: row.prices || {},
  spot_open_orders: row.spot_open_orders ?? 0, linear_open_orders: row.linear_open_orders ?? 0, checked_at: row.checked_at || null,
  source: row.source || "bybit_demo_api", last_error: row.last_error || null, age_seconds: Number.isFinite(ageMs(row.checked_at)) ? Math.max(0, Math.floor(ageMs(row.checked_at) / 1000)) : null,
  sends_exchange_orders: false,
});

async function refreshForUser(userId: string) {
  const client = admin();
  const { data: existing } = await client.from("bybit_demo_live_snapshot").select("*").eq("user_id", userId).maybeSingle();
  if (existing && ageMs(existing.checked_at) < CACHE_MS) return publicSnapshot(existing, false);
  try {
    credentials();
    const { data: openPositions, error: positionsError } = await client.from("open_positions_unified").select("symbol,market").eq("user_id", userId);
    if (positionsError) throw positionsError;
    const symbols = [...new Set((openPositions || []).map((position) => String(position.symbol || "")).filter(Boolean))];
    const [walletResult, linearResult, spotOrdersResult, linearOrdersResult, ...tickerResults] = await Promise.all([
      bybitGet("/v5/account/wallet-balance", { accountType: "UNIFIED" }),
      bybitGet("/v5/position/list", { category: "linear", settleCoin: "USDT", limit: 200 }),
      bybitGet("/v5/order/realtime", { category: "spot", openOnly: 0, limit: 50 }),
      bybitGet("/v5/order/realtime", { category: "linear", settleCoin: "USDT", openOnly: 0, limit: 50 }),
      ...symbols.map((symbol) => bybitGet("/v5/market/tickers", { category: (openPositions || []).some((p) => p.symbol === symbol && p.market === "futures") ? "linear" : "spot", symbol })),
    ]);
    const rawAccount = walletResult?.list?.[0] || {};
    const checkedAt = new Date().toISOString();
    const account = {
      total_equity: Number(rawAccount.totalEquity || 0), total_wallet_balance: Number(rawAccount.totalWalletBalance || 0),
      total_available_balance: Number(rawAccount.totalAvailableBalance || 0), total_margin_balance: Number(rawAccount.totalMarginBalance || 0),
      total_initial_margin: Number(rawAccount.totalInitialMargin || 0), total_maintenance_margin: Number(rawAccount.totalMaintenanceMargin || 0),
      total_perp_upl: Number(rawAccount.totalPerpUPL || 0), account_im_rate: Number(rawAccount.accountIMRate || 0), account_mm_rate: Number(rawAccount.accountMMRate || 0),
    };
    const assets = (rawAccount.coin || []).map((coin: Json) => ({
      coin: String(coin.coin || ""), equity: Number(coin.equity || 0), wallet_balance: Number(coin.walletBalance || 0),
      usd_value: Number(coin.usdValue || 0), locked: Number(coin.locked || 0), unrealised_pnl: Number(coin.unrealisedPnl || 0), cum_realised_pnl: Number(coin.cumRealisedPnl || 0),
    })).filter((coin: Json) => Math.abs(Number(coin.usd_value || 0)) > 0.000001 || Math.abs(Number(coin.wallet_balance || 0)) > 0.000001)
      .sort((a: Json, b: Json) => Number(b.usd_value || 0) - Number(a.usd_value || 0));
    const linearPositions = (linearResult?.list || []).filter((position: Json) => Number(position.size || 0) > 0).map((position: Json) => ({
      symbol: String(position.symbol || ""), side: String(position.side || ""), size: Number(position.size || 0), avg_price: Number(position.avgPrice || 0),
      mark_price: Number(position.markPrice || 0), position_value: Number(position.positionValue || 0), unrealised_pnl: Number(position.unrealisedPnl || 0),
      leverage: Number(position.leverage || 0), liquidation_price: position.liqPrice === "" ? null : Number(position.liqPrice || 0),
      stop_loss: position.stopLoss === "" ? null : Number(position.stopLoss || 0), take_profit: position.takeProfit === "" ? null : Number(position.takeProfit || 0),
    }));
    const prices: Record<string, Json> = {};
    tickerResults.forEach((result, index) => {
      const ticker = result?.list?.[0]; const symbol = symbols[index]; if (!ticker || !symbol) return;
      prices[symbol] = { symbol, market: (openPositions || []).some((p) => p.symbol === symbol && p.market === "futures") ? "futures" : "spot", last_price: Number(ticker.lastPrice || 0), mark_price: ticker.markPrice ? Number(ticker.markPrice) : null, checked_at: checkedAt };
    });
    const record = { user_id: userId, environment: "demo", account, assets, linear_positions: linearPositions, prices,
      spot_open_orders: (spotOrdersResult?.list || []).length, linear_open_orders: (linearOrdersResult?.list || []).length,
      checked_at: checkedAt, source: "bybit_demo_api", last_error: null, updated_at: checkedAt };
    const { data, error } = await client.from("bybit_demo_live_snapshot").upsert(record, { onConflict: "user_id" }).select("*").single();
    if (error) throw error;
    return publicSnapshot(data, false);
  } catch (error) {
    const safeError = message(error).slice(0, 500);
    if (existing) {
      await client.from("bybit_demo_live_snapshot").update({ last_error: safeError, updated_at: new Date().toISOString() }).eq("user_id", userId);
      return publicSnapshot({ ...existing, last_error: safeError }, true);
    }
    throw new Error(safeError);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ ok: false, error: "Method not allowed", sends_exchange_orders: false }, 405);
  try {
    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!token) return json({ ok: false, error: "Authentication required", sends_exchange_orders: false }, 401);
    if (token === serviceKey) {
      const client = admin();
      const { data, error } = await client.from("bot_configs").select("user_id").in("environment", ["demo", "demo_futures"]);
      if (error) throw error;
      const userIds = [...new Set((data || []).map((row) => String(row.user_id)).filter(Boolean))];
      const results = await Promise.allSettled(userIds.map(refreshForUser));
      return json({ ok: results.every((result) => result.status === "fulfilled"), refreshed_users: results.filter((result) => result.status === "fulfilled").length, failed_users: results.filter((result) => result.status === "rejected").length, sends_exchange_orders: false });
    }
    const client = admin();
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return json({ ok: false, error: "Invalid session", sends_exchange_orders: false }, 401);
    return json(await refreshForUser(user.id));
  } catch (error) {
    return json({ ok: false, error: message(error), sends_exchange_orders: false }, 400);
  }
});
