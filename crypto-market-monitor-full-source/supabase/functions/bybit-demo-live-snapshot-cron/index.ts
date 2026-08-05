import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed", sends_exchange_orders: false }, 405);
  const supplied = req.headers.get("x-bot-cron-token") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supplied || !supabaseUrl || !serviceKey) return json({ ok: false, error: "Not found", sends_exchange_orders: false }, 404);
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: secret, error } = await client.schema("private").from("bot_runtime_secrets").select("secret_value").eq("secret_name", "bot_cron").single();
  if (error || !secret?.secret_value || supplied !== secret.secret_value) return json({ ok: false, error: "Not found", sends_exchange_orders: false }, 404);
  const response = await fetch(`${supabaseUrl}/functions/v1/bybit-demo-live-snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json().catch(() => ({ ok: false, error: "Invalid response", sends_exchange_orders: false }));
  return json(body, response.status);
});
