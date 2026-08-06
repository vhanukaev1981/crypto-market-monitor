import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const OWNER_ID = "2e999f38-5e82-4441-9b14-ee7a659e8201";
const BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";
const CONNECTION_VERSION = "bybit-live-readonly-probe-v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}

async function requireOwner(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Unauthorized");
  const client = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_ANON_KEY") || "",
    { auth: { persistSession: false } },
  );
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.id !== OWNER_ID) throw new Error("Unauthorized");
  return data.user;
}

function credentials() {
  const apiKey = Deno.env.get("BYBIT_LIVE_API_KEY")?.trim();
  const apiSecret = Deno.env.get("BYBIT_LIVE_API_SECRET")?.trim();
  if (!apiKey || !apiSecret) throw new Error("Live credentials are not configured");
  return { apiKey, apiSecret };
}

async function hmacHex(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function bybitGet(path: string, params: Record<string, string> = {}) {
  const { apiKey, apiSecret } = credentials();
  const timestamp = Date.now().toString();
  const query = new URLSearchParams();
  Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).forEach(([key, value]) => query.set(key, value));
  const payload = query.toString();
  const signature = await hmacHex(apiSecret, timestamp + apiKey + RECV_WINDOW + payload);
  const url = `${BASE_URL}${path}${payload ? `?${payload}` : ""}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data: Record<string, any>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Bybit HTTP ${response.status}: invalid JSON`);
  }
  if (!response.ok || data.retCode !== 0) throw new Error(data.retMsg || `Bybit HTTP ${response.status}`);
  return data.result;
}

function permissionList(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function assertReadOnly(apiInfo: Record<string, any>) {
  if (Number(apiInfo.readOnly) !== 1) throw new Error("The Live API key must be read-only for the first connection stage");
  const permissions = apiInfo.permissions || {};
  const wallet = permissionList(permissions.Wallet);
  const spot = permissionList(permissions.Spot);
  const contract = permissionList(permissions.ContractTrade);
  const forbiddenWallet = wallet.filter((item) => ["Withdraw", "AccountTransfer", "SubMemberTransfer"].includes(item));
  if (forbiddenWallet.length) throw new Error("Wallet transfer or withdrawal permissions are forbidden");
  if (spot.includes("SpotTrade") || contract.includes("Order") || contract.includes("Position")) {
    throw new Error("Trading permissions are forbidden during the read-only connection stage");
  }
  return {
    read: true,
    trade: false,
    withdraw: false,
    readOnly: true,
    spot,
    contract,
    wallet,
  };
}

async function markFailure(errorText: string) {
  const client = adminClient();
  await client
    .from("exchange_connections")
    .update({ status: "error", last_error: errorText.slice(0, 500), last_checked_at: new Date().toISOString(), trading_enabled: false, withdrawals_enabled: false, is_read_only: true })
    .eq("user_id", OWNER_ID)
    .eq("exchange", "bybit")
    .eq("environment", "mainnet");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    await requireOwner(req);
    const apiInfo = await bybitGet("/v5/user/query-api");
    const permissions = assertReadOnly(apiInfo);
    const wallet = await bybitGet("/v5/account/wallet-balance", { accountType: "UNIFIED" });
    const account = wallet?.list?.[0] || {};
    const { apiKey } = credentials();
    const checkedAt = new Date().toISOString();
    const client = adminClient();

    const connectionUpdate = await client
      .from("exchange_connections")
      .update({
        status: "connected",
        api_key_last4: apiKey.slice(-4),
        permissions,
        credential_ref: "BYBIT_LIVE_API_KEY/BYBIT_LIVE_API_SECRET",
        connector_version: CONNECTION_VERSION,
        is_read_only: true,
        trading_enabled: false,
        withdrawals_enabled: false,
        last_checked_at: checkedAt,
        last_error: null,
        metadata: {
          connection_stage: "live_read_only",
          platform_core_controls_execution: false,
          account_type: account.accountType || "UNIFIED",
          unified_margin_status: account.unifiedMarginStatus ?? null,
        },
      })
      .eq("user_id", OWNER_ID)
      .eq("exchange", "bybit")
      .eq("environment", "mainnet")
      .select("id")
      .single();
    if (connectionUpdate.error) throw connectionUpdate.error;

    const accountUpdate = await client
      .from("trading_accounts")
      .update({
        status: "connected",
        trading_enabled: false,
        withdrawals_enabled: false,
        last_sync_at: checkedAt,
        last_error: null,
        metadata: {
          connection_stage: "live_read_only",
          platform_core_execution_locked: true,
          credentials_verified: true,
        },
      })
      .eq("connection_id", connectionUpdate.data.id)
      .eq("environment", "live");
    if (accountUpdate.error) throw accountUpdate.error;

    return json({
      ok: true,
      environment: "live",
      mode: "read_only",
      endpoint: BASE_URL,
      apiKeyLast4: apiKey.slice(-4),
      permissions,
      account: {
        accountType: account.accountType || "UNIFIED",
        totalEquity: account.totalEquity ? Number(account.totalEquity) : null,
        totalWalletBalance: account.totalWalletBalance ? Number(account.totalWalletBalance) : null,
        totalAvailableBalance: account.totalAvailableBalance ? Number(account.totalAvailableBalance) : null,
      },
      tradingEnabled: false,
      withdrawalsEnabled: false,
      checkedAt,
    });
  } catch (error) {
    const errorText = message(error);
    await markFailure(errorText).catch(() => undefined);
    const status = errorText === "Unauthorized" ? 401 : errorText.includes("not configured") ? 503 : 400;
    return json({ ok: false, environment: "live", mode: "read_only", error: errorText }, status);
  }
});
