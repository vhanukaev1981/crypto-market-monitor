import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const OWNER_ID = "2e999f38-5e82-4441-9b14-ee7a659e8201";
const RECV_WINDOW = "5000";
const VERSION = "bybit-live-trade-permission-probe-v3-unified-aware";

type Row = Record<string, any>;
type Candidate = { label: string; baseUrl: string; kind: "mainnet" | "demo" | "testnet" };

type Attempt = {
  label: string;
  kind: Candidate["kind"];
  httpStatus: number;
  retCode: number | null;
  retMsg: string;
  result: Row | null;
};

const CANDIDATES: Candidate[] = [
  { label: "global_mainnet", baseUrl: "https://api.bybit.com", kind: "mainnet" },
  { label: "global_mainnet_alt", baseUrl: "https://api.bytick.com", kind: "mainnet" },
  { label: "mainnet_demo", baseUrl: "https://api-demo.bybit.com", kind: "demo" },
  { label: "testnet", baseUrl: "https://api-testnet.bybit.com", kind: "testnet" },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}

async function requireCronToken(req: Request) {
  const supplied = req.headers.get("x-bot-cron-token")?.trim() || "";
  if (!supplied) throw new Error("Unauthorized");

  const client = adminClient();
  const { data, error } = await client
    .schema("private")
    .from("bot_runtime_secrets")
    .select("secret_value")
    .eq("secret_name", "bot_cron")
    .single();

  if (error || !data?.secret_value || supplied !== data.secret_value) {
    throw new Error("Unauthorized");
  }
}

function credentials() {
  const apiKey = Deno.env.get("BYBIT_LIVE_TRADE_API_KEY")?.trim();
  const apiSecret = Deno.env.get("BYBIT_LIVE_TRADE_API_SECRET")?.trim();
  if (!apiKey || !apiSecret) throw new Error("Live trade credentials are not configured");
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

async function probe(candidate: Candidate): Promise<Attempt> {
  const { apiKey, apiSecret } = credentials();
  const timestamp = Date.now().toString();
  const signature = await hmacHex(apiSecret, timestamp + apiKey + RECV_WINDOW);

  try {
    const response = await fetch(`${candidate.baseUrl}/v5/user/query-api`, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "Accept": "application/json",
        "cdn-request-id": crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(10_000),
    });

    const text = await response.text();
    let payload: Row = {};
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        label: candidate.label,
        kind: candidate.kind,
        httpStatus: response.status,
        retCode: null,
        retMsg: "invalid JSON response",
        result: null,
      };
    }

    return {
      label: candidate.label,
      kind: candidate.kind,
      httpStatus: response.status,
      retCode: typeof payload.retCode === "number" ? payload.retCode : null,
      retMsg: String(payload.retMsg || ""),
      result: payload.result && typeof payload.result === "object" ? payload.result : null,
    };
  } catch (error) {
    return {
      label: candidate.label,
      kind: candidate.kind,
      httpStatus: 0,
      retCode: null,
      retMsg: errorMessage(error),
      result: null,
    };
  }
}

function asList(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function requireEmpty(scope: string, values: string[]) {
  if (values.length) throw new Error(`${scope} permissions are forbidden for the Spot pilot key`);
}

function validateSpotOnly(apiInfo: Row) {
  if (Number(apiInfo.readOnly) !== 0) {
    throw new Error("The execution API key must be Read & Write");
  }

  const source = apiInfo.permissions || {};
  const permissions = {
    spot: asList(source.Spot),
    contract: asList(source.ContractTrade),
    options: asList(source.Options),
    derivatives: asList(source.Derivatives),
    wallet: asList(source.Wallet),
    exchange: asList(source.Exchange),
    earn: asList(source.Earn),
    fiatP2P: asList(source.FiatP2P),
    fiatBitPay: asList(source.FiatBitPay),
    fiatConvertBroker: asList(source.FiatConvertBroker),
    bitCard: asList(source.BitCard),
    byXPost: asList(source.ByXPost),
    affiliate: asList(source.Affiliate),
    blockTrade: asList(source.BlockTrade),
  };

  if (!permissions.spot.includes("SpotTrade")) {
    throw new Error("SpotTrade permission is required");
  }
  const unexpectedSpot = permissions.spot.filter((value) => value !== "SpotTrade");
  if (unexpectedSpot.length) {
    throw new Error(`Unexpected Spot permission: ${unexpectedSpot.join(", ")}`);
  }

  requireEmpty("ContractTrade", permissions.contract);
  requireEmpty("Options", permissions.options);
  requireEmpty("Wallet", permissions.wallet);
  requireEmpty("Exchange", permissions.exchange);
  requireEmpty("Earn", permissions.earn);
  requireEmpty("FiatP2P", permissions.fiatP2P);
  requireEmpty("FiatBitPay", permissions.fiatBitPay);
  requireEmpty("FiatConvertBroker", permissions.fiatConvertBroker);
  requireEmpty("BitCard", permissions.bitCard);
  requireEmpty("ByXPost", permissions.byXPost);
  requireEmpty("Affiliate", permissions.affiliate);
  requireEmpty("BlockTrade", permissions.blockTrade);

  const unexpectedDerivatives = permissions.derivatives.filter((value) => value !== "DerivativesTrade");
  if (unexpectedDerivatives.length) {
    throw new Error(`Unexpected Derivatives permission: ${unexpectedDerivatives.join(", ")}`);
  }

  return {
    readOnly: false,
    read: true,
    trade: true,
    spotTrade: true,
    contractOrder: false,
    contractPosition: false,
    optionsTrade: false,
    unifiedDerivativesScope: permissions.derivatives.includes("DerivativesTrade"),
    transfers: false,
    withdrawals: false,
  };
}

async function saveMetadata(fields: Row) {
  const client = adminClient();
  const { data } = await client
    .from("exchange_connections")
    .select("metadata")
    .eq("user_id", OWNER_ID)
    .eq("exchange", "bybit")
    .eq("environment", "mainnet")
    .single();

  await client
    .from("exchange_connections")
    .update({
      trading_enabled: false,
      withdrawals_enabled: false,
      is_read_only: true,
      metadata: { ...(data?.metadata || {}), ...fields },
    })
    .eq("user_id", OWNER_ID)
    .eq("exchange", "bybit")
    .eq("environment", "mainnet");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    await requireCronToken(req);
    credentials();

    const attempts: Attempt[] = [];
    let match: Attempt | null = null;

    for (const candidate of CANDIDATES) {
      const attempt = await probe(candidate);
      attempts.push(attempt);
      if (attempt.retCode === 0 && attempt.result) {
        match = attempt;
        break;
      }
    }

    const checkedAt = new Date().toISOString();
    const safeAttempts = attempts.map(({ label, kind, httpStatus, retCode, retMsg }) => ({
      label,
      environmentClass: kind,
      httpStatus,
      retCode,
      retMsg: retMsg.slice(0, 160),
    }));

    if (!match) {
      await saveMetadata({
        trade_key_verified: false,
        trade_key_checked_at: checkedAt,
        trade_key_detected_environment: null,
        trade_key_detected_domain: null,
        trade_key_last_error: "The API key was not accepted by any tested official Bybit environment",
        trade_key_domain_diagnostics: safeAttempts,
      });
      return json({
        ok: false,
        mode: "permission_probe_only",
        version: VERSION,
        error: "The API key was not accepted by any tested official Bybit environment",
        attempts: safeAttempts,
        tradingEnabled: false,
        withdrawalsEnabled: false,
      }, 400);
    }

    const detectedDomain = CANDIDATES.find((candidate) => candidate.label === match?.label)?.baseUrl || null;

    let permissions;
    try {
      permissions = validateSpotOnly(match.result || {});
    } catch (error) {
      const reason = errorMessage(error);
      await saveMetadata({
        trade_key_verified: false,
        trade_key_checked_at: checkedAt,
        trade_key_detected_environment: match.label,
        trade_key_detected_domain: detectedDomain,
        trade_key_last_error: reason,
        trade_key_domain_diagnostics: safeAttempts,
      });
      return json({
        ok: false,
        mode: "permission_probe_only",
        version: VERSION,
        detectedEnvironment: match.label,
        error: reason,
        tradingEnabled: false,
        withdrawalsEnabled: false,
      }, 400);
    }

    const isMainnet = match.kind === "mainnet";
    const ips = asList(match.result?.ips);
    const ipRestrictionsConfigured = ips.length > 0;

    await saveMetadata({
      trade_key_verified: isMainnet,
      trade_key_checked_at: checkedAt,
      trade_key_detected_environment: match.label,
      trade_key_detected_domain: detectedDomain,
      trade_key_permissions: permissions,
      trade_key_last_error: isMainnet ? null : `Key belongs to ${match.label}, not Live Mainnet`,
      trade_key_domain_diagnostics: safeAttempts,
      trade_key_ip_restrictions_configured: ipRestrictionsConfigured,
      static_egress_required_before_enable: !ipRestrictionsConfigured,
      execution_gateway_required_before_enable: true,
    });

    return json({
      ok: isMainnet,
      mode: "permission_probe_only",
      version: VERSION,
      detectedEnvironment: match.label,
      permissions,
      ipRestrictionsConfigured,
      readyForEnable: false,
      error: isMainnet ? null : `The key is valid, but belongs to ${match.label} rather than Live Mainnet`,
      tradingEnabled: false,
      withdrawalsEnabled: false,
      killSwitchRemainsRequired: true,
      checkedAt,
    }, isMainnet ? 200 : 409);
  } catch (error) {
    const reason = errorMessage(error);
    const status = reason === "Unauthorized" ? 401 : reason.includes("not configured") ? 503 : 400;
    return json({
      ok: false,
      mode: "permission_probe_only",
      version: VERSION,
      error: reason,
      tradingEnabled: false,
      withdrawalsEnabled: false,
    }, status);
  }
});