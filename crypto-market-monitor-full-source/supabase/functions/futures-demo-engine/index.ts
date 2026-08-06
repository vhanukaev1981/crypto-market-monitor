import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const BASE_URL = "https://api-demo.bybit.com";
const OWNER_ID = "2e999f38-5e82-4441-9b14-ee7a659e8201";
const CONFIG_NAME = "Bybit Futures Demo Pilot";
const CONFIG_ENVIRONMENT = "demo_futures";
const SHADOW_BOT_ID = "41b06796-51df-497c-be7a-83e23ab657cf";
const RECV_WINDOW = "5000";
const MIN_NOTIONAL = 10;
const MAX_NOTIONAL = 50;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function msg(error) { return error instanceof Error ? error.message : String(error); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function db() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}
function credentials() {
  const apiKey = Deno.env.get("BYBIT_DEMO_API_KEY")?.trim();
  const apiSecret = Deno.env.get("BYBIT_DEMO_API_SECRET")?.trim();
  if (!apiKey || !apiSecret) throw new Error("Bybit Demo credentials are not configured");
  if (Deno.env.get("BYBIT_BASE_URL")?.trim() !== BASE_URL || Deno.env.get("BYBIT_ENV")?.trim().toLowerCase() !== "demo") {
    throw new Error("Futures engine is locked to Bybit Demo");
  }
  return { apiKey, apiSecret };
}
async function hmacHex(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature)).map((v) => v.toString(16).padStart(2, "0")).join("");
}
async function bybit(path, method = "GET", params = {}, allowedCodes = []) {
  const { apiKey, apiSecret } = credentials();
  const timestamp = Date.now().toString();
  let payload = "";
  let url = BASE_URL + path;
  if (method === "GET") {
    const query = new URLSearchParams();
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([key, value]) => query.set(key, String(value)));
    payload = query.toString();
    if (payload) url += `?${payload}`;
  } else {
    payload = JSON.stringify(params);
  }
  const signature = await hmacHex(apiSecret, timestamp + apiKey + RECV_WINDOW + payload);
  const response = await fetch(url, {
    method,
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: method === "POST" ? payload : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({ retCode: -1, retMsg: "Invalid JSON" }));
  if ((!response.ok || data?.retCode !== 0) && !allowedCodes.includes(Number(data?.retCode))) {
    throw new Error(`${path}: ${data?.retMsg || `HTTP ${response.status}`} (${data?.retCode ?? "unknown"})`);
  }
  return data?.result || {};
}
async function publicGet(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => query.set(key, String(value)));
  const response = await fetch(`${BASE_URL}${path}?${query.toString()}`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok || data?.retCode !== 0) throw new Error(data?.retMsg || `Public HTTP ${response.status}`);
  return data.result;
}
function decimals(stepText) {
  const text = String(stepText).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] || 0);
  return (text.split(".")[1] || "").length;
}
function quantizeDown(value, stepText) {
  const step = Number(stepText);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0) return "0";
  const places = Math.min(18, decimals(stepText));
  const units = Math.floor((value + step * 1e-9) / step);
  return (units * step).toFixed(places).replace(/0+$/, "").replace(/\.$/, "");
}
function quantizeNearest(value, stepText) {
  const step = Number(stepText);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0) return "0";
  const places = Math.min(18, decimals(stepText));
  const units = Math.round(value / step);
  return (units * step).toFixed(places).replace(/0+$/, "").replace(/\.$/, "");
}
async function instrument(symbol) {
  const result = await publicGet("/v5/market/instruments-info", { category: "linear", symbol });
  const item = result?.list?.[0];
  if (!item) throw new Error(`Instrument unavailable for ${symbol}`);
  const lot = item.lotSizeFilter || {};
  const price = item.priceFilter || {};
  return {
    qtyStep: String(lot.qtyStep || lot.minOrderQty || "0.001"),
    minQty: Number(lot.minOrderQty || 0),
    minNotional: Number(lot.minNotionalValue || 5),
    tickSize: String(price.tickSize || "0.01"),
  };
}
async function ticker(symbol) {
  const result = await publicGet("/v5/market/tickers", { category: "linear", symbol });
  const row = result?.list?.[0];
  const last = Number(row?.lastPrice || 0);
  const mark = Number(row?.markPrice || last);
  if (!(last > 0) || !(mark > 0)) throw new Error(`Ticker unavailable for ${symbol}`);
  return { last, mark };
}
async function accountSnapshot() {
  const [wallet, positions, orders] = await Promise.all([
    bybit("/v5/account/wallet-balance", "GET", { accountType: "UNIFIED" }),
    bybit("/v5/position/list", "GET", { category: "linear", settleCoin: "USDT", limit: 200 }),
    bybit("/v5/order/realtime", "GET", { category: "linear", settleCoin: "USDT", openOnly: 0, limit: 50 }),
  ]);
  const account = wallet?.list?.[0] || {};
  const openPositions = (positions?.list || []).filter((p) => Number(p.size || 0) > 0);
  return {
    totalEquity: Number(account.totalEquity || 0),
    availableBalance: Number(account.totalAvailableBalance || 0),
    openPositions,
    openOrders: orders?.list || [],
  };
}
async function setOneWayAndLeverage(symbol) {
  await bybit("/v5/position/switch-mode", "POST", { category: "linear", symbol, mode: 0 }, [110025]);
  await bybit("/v5/position/set-leverage", "POST", {
    category: "linear", symbol, buyLeverage: "1", sellLeverage: "1",
  }, [110043]);
}
async function waitForPosition(symbol, present, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const result = await bybit("/v5/position/list", "GET", { category: "linear", symbol });
    const row = (result?.list || []).find((p) => Number(p.size || 0) > 0) || null;
    if (present ? Boolean(row) : !row) return row;
    await sleep(650 + i * 180);
  }
  return null;
}
async function executionsFor(orderLinkId, symbol) {
  for (let i = 0; i < 8; i++) {
    const result = await bybit("/v5/execution/list", "GET", {
      category: "linear", symbol, orderLinkId, limit: 50,
    });
    const rows = result?.list || [];
    if (rows.length) return rows;
    await sleep(500 + i * 180);
  }
  return [];
}
function executionTotals(rows) {
  let qty = 0, notional = 0, fees = 0;
  for (const row of rows) {
    const q = Number(row.execQty || 0);
    const p = Number(row.execPrice || 0);
    qty += q;
    notional += Number(row.execValue || q * p);
    fees += Math.abs(Number(row.execFee || 0));
  }
  return { qty, notional, fees, avgPrice: qty > 0 ? notional / qty : 0 };
}
async function saveOrderAndExecutions(client, config, order, orderLinkId, symbol, side, qty, reduceOnly, raw) {
  const saved = await client.from("orders").insert({
    user_id: OWNER_ID,
    bot_id: config.id,
    exchange_order_id: order?.orderId || null,
    order_link_id: orderLinkId,
    environment: "demo",
    category: "linear",
    symbol,
    side,
    order_type: "Market",
    qty: Number(qty),
    status: "Created",
    reduce_only: reduceOnly,
    raw,
  }).select("id").single();
  if (saved.error) throw saved.error;
  const rows = await executionsFor(orderLinkId, symbol);
  for (const row of rows) {
    const q = Number(row.execQty || 0);
    const p = Number(row.execPrice || 0);
    const fee = Math.abs(Number(row.execFee || 0));
    const result = await client.from("executions").upsert({
      id: String(row.execId), user_id: OWNER_ID, order_id: saved.data.id, symbol,
      side: String(row.side || side), qty: q, price: p, fee,
      fee_currency: row.feeCurrency || "USDT", fee_usdt: fee,
      fee_conversion_price: 1, notional_usdt: Number(row.execValue || q * p),
      is_maker: Boolean(row.isMaker), realized_pnl: Number(row.execPnl || 0),
      executed_at: new Date(Number(row.execTime || Date.now())).toISOString(), raw: row,
    }, { onConflict: "id" });
    if (result.error) throw result.error;
  }
  const totals = executionTotals(rows);
  await client.from("orders").update({
    status: rows.length ? "Filled" : "Accepted",
    raw: { ...raw, executions: rows }, updated_at: new Date().toISOString(),
  }).eq("id", saved.data.id);
  return { orderDbId: saved.data.id, rows, ...totals };
}
async function riskEvent(client, botId, severity, code, message, details = {}) {
  await client.from("risk_events").insert({
    user_id: OWNER_ID, bot_id: botId, severity, code, message, details,
  });
}
async function latestClosedPnl(symbol, openedAt) {
  const result = await bybit("/v5/position/closed-pnl", "GET", { category: "linear", symbol, limit: 50 });
  const threshold = new Date(openedAt).getTime() - 60_000;
  return (result?.list || [])
    .filter((row) => Number(row.updatedTime || row.createdTime || 0) >= threshold)
    .sort((a, b) => Number(b.updatedTime || 0) - Number(a.updatedTime || 0))[0] || null;
}
async function reconcileClosedPosition(client, position) {
  const closed = await latestClosedPnl(position.symbol, position.opened_at);
  if (!closed) return false;
  const entry = Number(closed.avgEntryPrice || position.avg_entry_price || 0);
  const exit = Number(closed.avgExitPrice || 0);
  const qty = Number(closed.qty || position.qty || 0);
  const gross = position.side === "short" ? (entry - exit) * qty : (exit - entry) * qty;
  const openFee = Math.abs(Number(closed.openFee || position.entry_fee_usdt || 0));
  const closeFee = Math.abs(Number(closed.closeFee || 0));
  const net = Number.isFinite(Number(closed.closedPnl)) ? Number(closed.closedPnl) : gross - openFee - closeFee;
  const update = await client.from("futures_positions").update({
    status: "closed", avg_exit_price: exit || null, gross_pnl: gross,
    entry_fee_usdt: openFee, exit_fee_usdt: closeFee, net_pnl: net,
    realized_pnl: net, unrealized_pnl: 0, exit_reason: "exchange_position_closed",
    closed_at: new Date(Number(closed.updatedTime || Date.now())).toISOString(),
    metadata: { ...(position.metadata || {}), closed_pnl: closed },
  }).eq("id", position.id);
  if (update.error) throw update.error;
  return true;
}
async function closeTrackedPosition(client, config, position, reason) {
  const exchange = await waitForPosition(position.symbol, true, 2);
  if (!exchange) {
    await reconcileClosedPosition(client, position);
    return { type: "already_closed", symbol: position.symbol };
  }
  const closeSide = position.side === "long" ? "Sell" : "Buy";
  const info = await instrument(position.symbol);
  const qty = quantizeDown(Number(exchange.size || position.qty), info.qtyStep);
  const orderLinkId = `fd_close_${position.symbol.toLowerCase()}_${Date.now()}`.slice(0, 36);
  const request = {
    category: "linear", symbol: position.symbol, side: closeSide,
    orderType: "Market", qty, reduceOnly: true, closeOnTrigger: true,
    positionIdx: 0, orderLinkId,
  };
  const order = await bybit("/v5/order/create", "POST", request);
  const fill = await saveOrderAndExecutions(client, config, order, orderLinkId, position.symbol, closeSide, qty, true, { request, response: order, reason });
  await waitForPosition(position.symbol, false, 12);
  const closed = await latestClosedPnl(position.symbol, position.opened_at);
  const exit = Number(closed?.avgExitPrice || fill.avgPrice || exchange.markPrice || 0);
  const entry = Number(position.avg_entry_price);
  const soldQty = Number(closed?.qty || fill.qty || position.qty);
  const gross = position.side === "short" ? (entry - exit) * soldQty : (exit - entry) * soldQty;
  const openFee = Math.abs(Number(closed?.openFee || position.entry_fee_usdt || 0));
  const closeFee = Math.abs(Number(closed?.closeFee || fill.fees || 0));
  const net = Number.isFinite(Number(closed?.closedPnl)) ? Number(closed.closedPnl) : gross - openFee - closeFee;
  const update = await client.from("futures_positions").update({
    status: "closed", avg_exit_price: exit || null, gross_pnl: gross,
    exit_fee_usdt: closeFee, net_pnl: net, realized_pnl: net,
    unrealized_pnl: 0, exit_order_id: order?.orderId || null,
    exit_order_link_id: orderLinkId, exit_reason: reason,
    closed_at: new Date().toISOString(), metadata: { ...(position.metadata || {}), closed_pnl: closed },
  }).eq("id", position.id);
  if (update.error) throw update.error;
  return { type: "closed", symbol: position.symbol, reason, netPnl: net };
}
function consensusFromSignals(rows, minConfidence, required) {
  const groups = new Map();
  for (const row of rows) {
    const direction = row.signal === "short" || row.direction === "short" ? "short" : row.signal === "buy" || row.direction === "long" ? "long" : null;
    if (!direction || Number(row.confidence || 0) < minConfidence) continue;
    const key = `${row.symbol}:${direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const candidates = [];
  for (const [key, signals] of groups.entries()) {
    const distinct = [...new Map(signals.map((row) => [row.strategy_key, row])).values()];
    if (distinct.length < required) continue;
    const [symbol, side] = key.split(":");
    const confidence = distinct.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / distinct.length;
    const strongest = [...distinct].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
    candidates.push({ symbol, side, confidence, signals: distinct, strongest, consensusCount: distinct.length });
  }
  return candidates.sort((a, b) => b.consensusCount - a.consensusCount || b.confidence - a.confidence);
}
async function placeEntry(client, config, candidate, availableBalance) {
  const risk = config.risk || {};
  const info = await instrument(candidate.symbol);
  const prices = await ticker(candidate.symbol);
  const entry = prices.last;
  const sourcePrice = Number(candidate.strongest.price || entry);
  const sourceStop = Number(candidate.strongest.stop_loss || 0);
  const sourceTake = Number(candidate.strongest.take_profit || 0);
  let stopPct = candidate.side === "short" ? (sourceStop / sourcePrice - 1) * 100 : (1 - sourceStop / sourcePrice) * 100;
  let takePct = candidate.side === "short" ? (1 - sourceTake / sourcePrice) * 100 : (sourceTake / sourcePrice - 1) * 100;
  stopPct = clamp(Number.isFinite(stopPct) ? stopPct : 1, 0.7, 4);
  takePct = clamp(Number.isFinite(takePct) ? takePct : stopPct * 2, stopPct * 1.4, 8);
  const riskBudget = Number(risk.reference_capital_usdt || 800) * Number(risk.risk_per_trade_pct || 0.1) / 100;
  const maxTrade = Math.min(MAX_NOTIONAL, Number(risk.max_usdt_per_trade || MAX_NOTIONAL));
  const notional = Math.min(maxTrade, riskBudget / (stopPct / 100), availableBalance * 0.25);
  if (notional < Math.max(MIN_NOTIONAL, info.minNotional)) throw new Error(`Risk-sized notional is too small: ${notional.toFixed(2)}`);
  const qty = quantizeDown(notional / entry, info.qtyStep);
  if (Number(qty) < info.minQty || Number(qty) * entry < info.minNotional) throw new Error("Order is below Futures minimum");
  const stopRaw = candidate.side === "short" ? entry * (1 + stopPct / 100) : entry * (1 - stopPct / 100);
  const takeRaw = candidate.side === "short" ? entry * (1 - takePct / 100) : entry * (1 + takePct / 100);
  const stopLoss = quantizeNearest(stopRaw, info.tickSize);
  const takeProfit = quantizeNearest(takeRaw, info.tickSize);
  await setOneWayAndLeverage(candidate.symbol);
  const orderLinkId = `fd_entry_${candidate.symbol.toLowerCase()}_${Date.now()}`.slice(0, 36);
  const side = candidate.side === "long" ? "Buy" : "Sell";
  const request = {
    category: "linear", symbol: candidate.symbol, side, orderType: "Market", qty,
    positionIdx: 0, orderLinkId, reduceOnly: false,
    takeProfit, stopLoss, tpslMode: "Full", tpOrderType: "Market", slOrderType: "Market",
    tpTriggerBy: "MarkPrice", slTriggerBy: "MarkPrice",
  };
  const order = await bybit("/v5/order/create", "POST", request);
  const fill = await saveOrderAndExecutions(client, config, order, orderLinkId, candidate.symbol, side, qty, false, { request, response: order, candidate });
  const exchange = await waitForPosition(candidate.symbol, true, 12);
  if (!exchange) throw new Error("Entry was not visible as an open Futures position");
  const verified = Number(exchange.stopLoss || 0) > 0 && Number(exchange.takeProfit || 0) > 0;
  if (!verified) {
    await riskEvent(client, config.id, "critical", "FUTURES_NATIVE_PROTECTION_FAILED", `${candidate.symbol} opened without verified native protection`, { exchange, orderLinkId });
    const closeSide = candidate.side === "long" ? "Sell" : "Buy";
    const closeLink = `fd_unwind_${candidate.symbol.toLowerCase()}_${Date.now()}`.slice(0, 36);
    const closeRequest = { category: "linear", symbol: candidate.symbol, side: closeSide, orderType: "Market", qty: String(exchange.size), reduceOnly: true, closeOnTrigger: true, positionIdx: 0, orderLinkId: closeLink };
    const closeOrder = await bybit("/v5/order/create", "POST", closeRequest);
    await saveOrderAndExecutions(client, config, closeOrder, closeLink, candidate.symbol, closeSide, exchange.size, true, { request: closeRequest, response: closeOrder, reason: "protection_failed_unwind" });
    await waitForPosition(candidate.symbol, false, 12);
    throw new Error("Native TP/SL verification failed; entry was unwound");
  }
  const avgEntry = Number(exchange.avgPrice || fill.avgPrice || entry);
  const actualQty = Number(exchange.size || fill.qty || qty);
  const actualNotional = Number(exchange.positionValue || actualQty * avgEntry);
  const margin = actualNotional / Math.max(1, Number(exchange.leverage || 1));
  const plannedRisk = actualNotional * stopPct / 100;
  const insert = await client.from("futures_positions").insert({
    user_id: OWNER_ID, bot_id: config.id, symbol: candidate.symbol, side: candidate.side,
    status: "open", qty: actualQty, avg_entry_price: avgEntry,
    mark_price: Number(exchange.markPrice || prices.mark), stop_loss_price: Number(exchange.stopLoss || stopLoss),
    take_profit_price: Number(exchange.takeProfit || takeProfit), leverage: 1,
    notional_usdt: actualNotional, margin_usdt: margin, risk_usdt: plannedRisk,
    unrealized_pnl: Number(exchange.unrealisedPnl || 0), entry_fee_usdt: fill.fees,
    entry_order_id: order?.orderId || null, entry_order_link_id: orderLinkId,
    strategy_key: candidate.strongest.strategy_key, confidence: candidate.confidence,
    consensus_count: candidate.consensusCount,
    entry_signal: { run_id: candidate.strongest.run_id, signals: candidate.signals },
    protection_status: "native_verified", protection_verified_at: new Date().toISOString(),
    native_sl_price: Number(exchange.stopLoss || stopLoss), native_tp_price: Number(exchange.takeProfit || takeProfit),
    liquidation_price: Number(exchange.liqPrice || 0) || null,
    metadata: { exchange_position: exchange, pilot_phase: 1, source: "futures_strategy_lab" },
  });
  if (insert.error) throw insert.error;
  return { type: "entry", symbol: candidate.symbol, side: candidate.side, notional: actualNotional, qty: actualQty, entry: avgEntry, stopLoss: Number(exchange.stopLoss || stopLoss), takeProfit: Number(exchange.takeProfit || takeProfit), consensus: candidate.consensusCount, confidence: candidate.confidence };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const client = db();
  let runId = null;
  try {
    const supplied = req.headers.get("x-bot-cron-token") || "";
    const secret = await client.schema("private").from("bot_runtime_secrets").select("secret_value").eq("secret_name", "bot_cron").single();
    if (secret.error || !secret.data?.secret_value || supplied !== secret.data.secret_value) return json({ ok: false, error: "Not found" }, 404);
    const configResult = await client.from("bot_configs").select("*").eq("user_id", OWNER_ID).eq("name", CONFIG_NAME).eq("environment", CONFIG_ENVIRONMENT).eq("category", "linear").single();
    if (configResult.error) throw configResult.error;
    const config = configResult.data;
    if (!config.enabled || config.kill_switch || config.status !== "running") return json({ ok: true, skipped: "futures_bot_not_armed" });
    const run = await client.from("bot_runs").insert({ user_id: OWNER_ID, bot_id: config.id, status: "started", metadata: { engine: "futures-demo-v1", actions: [] } }).select("id").single();
    if (run.error) throw run.error;
    runId = run.data.id;
    const actions = [];
    const snapshot = await accountSnapshot();
    const dbOpenResult = await client.from("futures_positions").select("*").eq("bot_id", config.id).in("status", ["open", "closing"]);
    if (dbOpenResult.error) throw dbOpenResult.error;
    const dbOpen = dbOpenResult.data || [];
    const exchangeBySymbol = new Map(snapshot.openPositions.map((p) => [String(p.symbol), p]));
    for (const position of dbOpen) {
      const exchange = exchangeBySymbol.get(position.symbol);
      if (!exchange) {
        const reconciled = await reconcileClosedPosition(client, position);
        actions.push({ type: reconciled ? "reconciled_closed" : "reconciliation_pending", symbol: position.symbol });
        continue;
      }
      exchangeBySymbol.delete(position.symbol);
      const expectedSide = position.side === "long" ? "Buy" : "Sell";
      if (String(exchange.side) !== expectedSide) {
        await riskEvent(client, config.id, "critical", "FUTURES_SIDE_MISMATCH", `${position.symbol} exchange side does not match ledger`, { position, exchange });
        actions.push({ type: "risk_block", reason: "side_mismatch", symbol: position.symbol });
        continue;
      }
      const mark = Number(exchange.markPrice || position.mark_price || 0);
      const entry = Number(position.avg_entry_price);
      const qty = Number(exchange.size || position.qty);
      const unrealized = position.side === "short" ? (entry - mark) * qty : (mark - entry) * qty;
      const favorable = Math.max(Number(position.max_favorable_excursion || 0), unrealized);
      const adverse = Math.min(Number(position.max_adverse_excursion || 0), unrealized);
      const protectedNow = Number(exchange.stopLoss || 0) > 0 && Number(exchange.takeProfit || 0) > 0;
      await client.from("futures_positions").update({ mark_price: mark, qty, unrealized_pnl: unrealized, max_favorable_excursion: favorable, max_adverse_excursion: adverse, protection_status: protectedNow ? "native_verified" : "missing", native_sl_price: Number(exchange.stopLoss || 0) || null, native_tp_price: Number(exchange.takeProfit || 0) || null, liquidation_price: Number(exchange.liqPrice || 0) || null }).eq("id", position.id);
      const ageMinutes = (Date.now() - new Date(position.opened_at).getTime()) / 60_000;
      if (!protectedNow) {
        await riskEvent(client, config.id, "critical", "FUTURES_PROTECTION_MISSING", `${position.symbol} native protection is missing; emergency close started`, { position_id: position.id, exchange });
        actions.push(await closeTrackedPosition(client, config, position, "native_protection_missing"));
      } else if (ageMinutes >= Number(config.risk?.max_holding_minutes || 720)) {
        actions.push(await closeTrackedPosition(client, config, position, "time_stop"));
      }
    }
    if (exchangeBySymbol.size > 0) {
      const untracked = [...exchangeBySymbol.values()].map((p) => ({ symbol: p.symbol, side: p.side, size: p.size }));
      await riskEvent(client, config.id, "critical", "UNTRACKED_FUTURES_POSITION", "Untracked Futures position detected; automated entries blocked", { untracked });
      actions.push({ type: "risk_block", reason: "untracked_exchange_position", untracked });
    }
    const refreshedOpen = await client.from("futures_positions").select("id,symbol").eq("bot_id", config.id).in("status", ["open", "closing"]);
    const risk = config.risk || {};
    const now = Date.now();
    const closed24h = await client.from("futures_positions").select("net_pnl,closed_at").eq("bot_id", config.id).eq("status", "closed").gte("closed_at", new Date(now - 24 * 3600_000).toISOString());
    const closed7d = await client.from("futures_positions").select("net_pnl").eq("bot_id", config.id).eq("status", "closed").gte("closed_at", new Date(now - 7 * 24 * 3600_000).toISOString());
    const allClosed = await client.from("futures_positions").select("net_pnl,closed_at").eq("bot_id", config.id).eq("status", "closed").order("closed_at", { ascending: false });
    if (closed24h.error || closed7d.error || allClosed.error) throw closed24h.error || closed7d.error || allClosed.error;
    const dailyPnl = (closed24h.data || []).reduce((sum, row) => sum + Number(row.net_pnl || 0), 0);
    const weeklyPnl = (closed7d.data || []).reduce((sum, row) => sum + Number(row.net_pnl || 0), 0);
    const pilotPnl = (allClosed.data || []).reduce((sum, row) => sum + Number(row.net_pnl || 0), 0);
    const recentLosses = (allClosed.data || []).slice(0, Number(risk.max_consecutive_losses || 2)).filter((row) => Number(row.net_pnl || 0) <= 0).length;
    let blocked = actions.some((a) => a.type === "risk_block");
    if (dailyPnl <= -Math.abs(Number(risk.max_daily_loss_usdt || 3))) { blocked = true; actions.push({ type: "risk_block", reason: "daily_loss_limit", dailyPnl }); }
    if (weeklyPnl <= -Math.abs(Number(risk.max_weekly_loss_usdt || 8))) { blocked = true; actions.push({ type: "risk_block", reason: "weekly_loss_limit", weeklyPnl }); }
    if (pilotPnl <= -Math.abs(Number(risk.max_pilot_loss_usdt || 12))) { blocked = true; actions.push({ type: "risk_block", reason: "pilot_loss_limit", pilotPnl }); }
    if ((allClosed.data || []).length >= Number(risk.max_consecutive_losses || 2) && recentLosses >= Number(risk.max_consecutive_losses || 2)) { blocked = true; actions.push({ type: "risk_block", reason: "consecutive_losses", recentLosses }); }
    if (snapshot.availableBalance < Number(risk.min_available_balance_usdt || 75)) { blocked = true; actions.push({ type: "risk_block", reason: "low_available_balance", availableBalance: snapshot.availableBalance }); }
    if ((refreshedOpen.data || []).length >= Number(risk.max_open_positions || 1)) blocked = true;
    if (!blocked && snapshot.openPositions.length === 0) {
      const latestRun = await client.from("strategy_lab_runs").select("id,ended_at,status,market_category,mode").eq("bot_id", SHADOW_BOT_ID).eq("status", "completed").eq("market_category", "linear").order("id", { ascending: false }).limit(1).maybeSingle();
      if (latestRun.error) throw latestRun.error;
      if (!latestRun.data || now - new Date(latestRun.data.ended_at).getTime() > 20 * 60_000) {
        actions.push({ type: "wait", reason: "no_fresh_futures_shadow_run" });
      } else {
        const signalsResult = await client.from("strategy_lab_signals").select("run_id,symbol,strategy_key,signal,direction,confidence,price,stop_loss,take_profit,reason,market_regime,candle_time,metadata").eq("run_id", latestRun.data.id).eq("market_category", "linear");
        if (signalsResult.error) throw signalsResult.error;
        const required = Number(config.strategy?.consensus_required || 2);
        const minConfidence = Number(config.strategy?.min_confidence || 0.82);
        const candidates = consensusFromSignals(signalsResult.data || [], minConfidence, required);
        const spotOpen = await client.from("bot_positions").select("symbol").eq("status", "open");
        if (spotOpen.error) throw spotOpen.error;
        const spotSymbols = new Set((spotOpen.data || []).map((row) => row.symbol));
        const cooldownFrom = new Date(now - Number(risk.cooldown_minutes || 90) * 60_000).toISOString();
        let selected = null;
        for (const candidate of candidates) {
          if (config.strategy?.exclude_open_spot_symbols !== false && spotSymbols.has(candidate.symbol)) continue;
          const recent = await client.from("futures_positions").select("id").eq("bot_id", config.id).eq("symbol", candidate.symbol).gte("opened_at", cooldownFrom).limit(1);
          if (recent.error) throw recent.error;
          if ((recent.data || []).length) continue;
          selected = candidate;
          break;
        }
        if (selected) {
          try { actions.push(await placeEntry(client, config, selected, snapshot.availableBalance)); }
          catch (error) { await riskEvent(client, config.id, "high", "FUTURES_ENTRY_ERROR", msg(error), { selected }); actions.push({ type: "entry_error", symbol: selected.symbol, error: msg(error) }); }
        } else {
          actions.push({ type: "wait", reason: "no_qualified_consensus", candidateCount: candidates.length });
        }
      }
    }
    await client.from("bot_configs").update({ status: "running", last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", config.id);
    await client.from("bot_runs").update({ status: "completed", ended_at: new Date().toISOString(), metadata: { engine: "futures-demo-v1", actions, account: { totalEquity: snapshot.totalEquity, availableBalance: snapshot.availableBalance }, dailyPnl, weeklyPnl, pilotPnl } }).eq("id", runId);
    return json({ ok: true, environment: CONFIG_ENVIRONMENT, category: "linear", leverage: 1, allows_short: true, actions, exchange_orders_possible: true, dailyPnl, weeklyPnl, pilotPnl });
  } catch (error) {
    if (runId !== null) await client.from("bot_runs").update({ status: "failed", reason: msg(error), ended_at: new Date().toISOString(), metadata: { engine: "futures-demo-v1" } }).eq("id", runId);
    console.error("futures-demo-engine", msg(error));
    return json({ ok: false, error: msg(error), environment: CONFIG_ENVIRONMENT, category: "linear" }, 400);
  }
});
