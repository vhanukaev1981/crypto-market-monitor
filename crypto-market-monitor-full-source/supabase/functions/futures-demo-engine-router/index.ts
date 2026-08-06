import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const ENGINE_URL = "https://xabffbjifmnoogzcttyd.supabase.co/functions/v1/futures-demo-engine";
const CONFIG_NAME = "Bybit Futures Demo Pilot";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const client = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );

  const supplied = req.headers.get("x-bot-cron-token") || "";
  const secret = await client
    .schema("private")
    .from("bot_runtime_secrets")
    .select("secret_value")
    .eq("secret_name", "bot_cron")
    .single();

  if (secret.error || !secret.data?.secret_value || supplied !== secret.data.secret_value) {
    return json({ ok: false, error: "Not found" }, 404);
  }

  const config = await client
    .from("bot_configs")
    .select("id,environment,category,enabled,kill_switch,status")
    .eq("name", CONFIG_NAME)
    .eq("category", "linear")
    .eq("environment", "demo_futures")
    .single();

  if (config.error) {
    return json({ ok: false, error: "Futures Demo config was not found" }, 409);
  }

  if (!config.data.enabled || config.data.kill_switch || config.data.status !== "running") {
    return json({ ok: true, skipped: "futures_bot_not_armed" });
  }

  try {
    const response = await fetch(ENGINE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-cron-token": supplied,
      },
      body: "{}",
      signal: AbortSignal.timeout(120_000),
    });

    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      502,
    );
  }
});
