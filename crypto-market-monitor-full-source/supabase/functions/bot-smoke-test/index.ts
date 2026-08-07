import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE_URL = "https://api-demo.bybit.com";
const MARKET_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function hmacHex(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature)).map((v) => v.toString(16).padStart(2, "0")).join("");
}

async function signedGet(path: string, params: Record<string, string> = {}) {
  const apiKey = Deno.env.get("BYBIT_DEMO_API_KEY")?.trim() || "";
  const apiSecret = Deno.env.get("BYBIT_DEMO_API_SECRET")?.trim() || "";
  if (!apiKey || !apiSecret) throw new Error("missing_credentials");
  if (Deno.env.get("BYBIT_BASE_URL")?.trim() !== BASE_URL || Deno.env.get("BYBIT_ENV")?.trim().toLowerCase() !== "demo") throw new Error("environment_mismatch");
  const query = new URLSearchParams(params).toString();
  const timestamp = Date.now().toString();
  const signature = await hmacHex(apiSecret, timestamp + apiKey + RECV_WINDOW + query);
  const response = await fetch(`${BASE_URL}${path}${query ? `?${query}` : ""}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "Accept": "application/json",
    },
  });
  const data = await response.json();
  if (!response.ok || data?.retCode !== 0) throw new Error(data?.retMsg || `http_${response.status}`);
  return data.result;
}

async function instrument(symbol: string) {
  const response = await fetch(`${MARKET_URL}/v5/market/instruments-info?category=spot&symbol=${symbol}`);
  const data = await response.json();
  const lot = data?.result?.list?.[0]?.lotSizeFilter;
  if (!response.ok || data?.retCode !== 0 || !lot) throw new Error(`instrument_${symbol}`);
  return {
    basePrecision: lot.basePrecision || null,
    quotePrecision: lot.quotePrecision || null,
    minOrderQty: lot.minOrderQty || null,
    minOrderAmt: lot.minOrderAmt || null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  try {
    const [keyInfo, wallet, ada, pepe] = await Promise.all([
      signedGet("/v5/user/query-api"),
      signedGet("/v5/account/wallet-balance", { accountType: "UNIFIED" }),
      instrument("ADAUSDT"),
      instrument("PEPEUSDT"),
    ]);
    return json({
      ok: true,
      environment: "demo",
      readOnly: keyInfo?.readOnly === 1,
      walletConnected: Boolean(wallet?.list?.length),
      precision: { ADAUSDT: ada, PEPEUSDT: pepe },
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
