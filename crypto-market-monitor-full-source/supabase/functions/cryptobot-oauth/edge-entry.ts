import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "npm:hono@4.9.12";
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
} from "../cryptobot-mcp/data.ts";
import {
  isStandalonePreviewTool,
  type StandalonePreviewTool,
} from "../../../src/cryptobot/preview-contract.ts";

const FUNCTION_NAME = "cryptobot-oauth";
const PROJECT_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const PUBLISHABLE_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const VERIFIED_WIDGET_COMMIT = "1587000700feeddab50e362310c678e8680c707b";
const RAW_ROOT = `https://raw.githubusercontent.com/vhanukaev1981/crypto-market-monitor/${VERIFIED_WIDGET_COMMIT}/crypto-market-monitor-full-source`;
const WIDGET_BUNDLE_URL = `${RAW_ROOT}/mcp/dist/widget.js`;

if (!PROJECT_URL || !PUBLISHABLE_KEY) throw new Error("supabase_runtime_config_missing");

const widgetResponse = await fetch(WIDGET_BUNDLE_URL, {
  headers: { Accept: "text/javascript" },
  signal: AbortSignal.timeout(8_000),
});
if (!widgetResponse.ok) throw new Error(`widget_bundle_fetch_failed:${widgetResponse.status}`);
const widgetBundle = await widgetResponse.text();
if (!widgetBundle.trim()) throw new Error("widget_bundle_empty");

const baseUrl = `${PROJECT_URL}/functions/v1/${FUNCTION_NAME}`;
const previewUrl = `${baseUrl}/preview`;

const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get("authorization") ?? "").trim());
  return match?.[1]?.trim() ?? null;
}

async function principalFor(request: Request): Promise<Principal | null> {
  const token = bearer(request);
  return token ? await authenticateBearer(token) : null;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "authentication_required" }), {
    status: 401,
    headers: { "Content-Type": "application/json", ...securityHeaders },
  });
}

async function runPreviewTool(principal: Principal, tool: StandalonePreviewTool, args: Record<string, unknown>) {
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

function escapeJsonForScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const consentHtml = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>CryptoBot — אישור גישה</title><style>:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color-scheme:dark;--bg:#06101d;--panel:#0b1828;--line:#21374f;--muted:#91a6c0;--text:#f0f6ff;--good:#36d399;--bad:#ff6b7a}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}body{display:grid;place-items:center;padding:18px;background:radial-gradient(circle at 80% 0%,rgba(91,170,255,.15),transparent 34%),var(--bg)}.card{width:min(100%,520px);padding:24px;border:1px solid rgba(94,132,173,.25);background:linear-gradient(180deg,#0d1d30,#081624);border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.35)}.brand{display:flex;align-items:center;gap:12px;margin-bottom:20px}.logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(145deg,#2a81ff,#7762ff);display:grid;place-items:center;font-weight:900}.brand h1{margin:0;font-size:20px}.brand p{margin:4px 0 0;color:var(--muted);font-size:11px}.notice{padding:11px 12px;border:1px solid rgba(54,211,153,.2);background:rgba(54,211,153,.06);border-radius:12px;font-size:11px;line-height:1.55;color:#c6f5e3;margin-bottom:16px}.muted{color:var(--muted);font-size:11px;line-height:1.55}.box{padding:14px;border:1px solid var(--line);border-radius:13px;background:rgba(4,14,25,.5);margin:12px 0}.label{font-size:10px;color:var(--muted);margin-bottom:5px}.value{font-size:13px;font-weight:700;word-break:break-word}.scopes{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.scope{padding:5px 8px;border:1px solid var(--line);border-radius:999px;font-size:10px;color:#c5d7ea}.actions{display:flex;gap:8px;margin-top:16px}.btn{flex:1;border:1px solid var(--line);border-radius:11px;padding:11px 12px;cursor:pointer;background:#0a1c30;color:white;font-weight:700}.btn.primary{background:linear-gradient(145deg,#267cff,#625cff);border-color:transparent}.btn.danger{color:#ffc2c8;border-color:rgba(255,107,122,.35)}input{width:100%;margin-top:7px;padding:12px;border:1px solid var(--line);border-radius:10px;background:#071522;color:white;outline:none}.status{margin-top:12px;font-size:11px;line-height:1.5}.error{color:#ffb6bf}.good{color:var(--good)}.hidden{display:none}.footer{text-align:center;color:var(--muted);font-size:9px;margin-top:16px}@media(max-width:520px){body{padding:10px}.card{padding:18px;border-radius:17px}.actions{flex-direction:column}}</style></head><body><main class="card"><div class="brand"><div class="logo">CB</div><div><h1>CryptoBot</h1><p>אישור גישה פרטי ל־ChatGPT Control Center</p></div></div><div class="notice">החיבור מאפשר <strong>קריאה בלבד</strong> של נתוני CryptoBot. אין בו כלי לפתיחת עסקה, שינוי פקודה, העברת כספים או משיכה.</div><div id="loading" class="muted">בודק את בקשת ההרשאה…</div><section id="login" class="hidden"><div class="muted">כדי לאשר את ChatGPT, התחבר לחשבון CryptoBot באמצעות קישור חד־פעמי למייל.</div><label><div class="label" style="margin-top:14px">כתובת אימייל</div><input id="email" type="email" autocomplete="email" placeholder="name@example.com"/></label><button id="send" class="btn primary" style="width:100%;margin-top:10px">שלח קישור התחברות</button><div id="loginStatus" class="status"></div></section><section id="consent" class="hidden"><div class="box"><div class="label">האפליקציה המבקשת גישה</div><div id="clientName" class="value">ChatGPT</div></div><div class="box"><div class="label">Redirect URI</div><div id="redirectUri" class="value"></div></div><div class="box"><div class="label">הרשאות מבוקשות</div><div id="scopes" class="scopes"></div></div><div class="muted">CryptoBot יאמת בנוסף שהמשתמש נמצא ב־allow-list הפרטי של הפרויקט בכל קריאת MCP.</div><div class="actions"><button id="approve" class="btn primary">אשר גישה</button><button id="deny" class="btn danger">דחה</button></div><div id="consentStatus" class="status"></div></section><section id="fatal" class="hidden"><div id="fatalText" class="status error"></div></section><div class="footer">CryptoBot OAuth · Supabase Auth · Read-Only MCP</div></main><script type="module">import{createClient}from'https://esm.sh/@supabase/supabase-js@2.55.0';const PROJECT_URL=${escapeJsonForScript(PROJECT_URL)},KEY=${escapeJsonForScript(PUBLISHABLE_KEY)},supabase=createClient(PROJECT_URL,KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce'}}),qs=new URLSearchParams(location.search),authorizationId=qs.get('authorization_id'),el=id=>document.getElementById(id);function show(id){['loading','login','consent','fatal'].forEach(x=>el(x).classList.toggle('hidden',x!==id))}function fatal(message){show('fatal');el('fatalText').textContent=message}async function restoreCode(){const code=qs.get('code');if(!code)return;const{error}=await supabase.auth.exchangeCodeForSession(code);if(error)throw error;qs.delete('code');history.replaceState({},'',location.pathname+'?'+qs.toString())}async function load(){try{if(!authorizationId)return fatal('חסר authorization_id. יש לפתוח את הדף דרך תהליך OAuth של ChatGPT.');await restoreCode();const{data:{user}}=await supabase.auth.getUser();if(!user){show('login');return}const{data,error}=await supabase.auth.oauth.getAuthorizationDetails(authorizationId);if(error)throw error;if(data?.redirect_url&&!data?.authorization_id){location.href=data.redirect_url;return}if(!data?.authorization_id)throw new Error('בקשת ההרשאה אינה זמינה');el('clientName').textContent=data.client?.name||'ChatGPT MCP Client';el('redirectUri').textContent=data.redirect_uri||'לא זמין';const scopes=String(data.scope||'email').split(/\s+/).filter(Boolean);el('scopes').innerHTML=scopes.map(x=>'<span class="scope">'+x.replace(/[<>&]/g,'')+'</span>').join('');show('consent')}catch(e){fatal(e?.message||String(e))}}el('send').onclick=async()=>{const email=el('email').value.trim();if(!email){el('loginStatus').textContent='יש להזין אימייל.';el('loginStatus').className='status error';return}el('send').disabled=true;el('loginStatus').textContent='שולח קישור…';try{const{error}=await supabase.auth.signInWithOtp({email,options:{shouldCreateUser:false}});if(error)throw error;el('loginStatus').textContent='נשלח קישור חד־פעמי. פתח אותו במייל כדי לחזור למסך האישור.';el('loginStatus').className='status good'}catch(e){el('loginStatus').textContent=e?.message||String(e);el('loginStatus').className='status error'}finally{el('send').disabled=false}};el('approve').onclick=async()=>{el('approve').disabled=true;el('consentStatus').textContent='מאשר…';try{const{data,error}=await supabase.auth.oauth.approveAuthorization(authorizationId);if(error)throw error;location.href=data.redirect_url}catch(e){el('consentStatus').textContent=e?.message||String(e);el('consentStatus').className='status error';el('approve').disabled=false}};el('deny').onclick=async()=>{el('deny').disabled=true;try{const{data,error}=await supabase.auth.oauth.denyAuthorization(authorizationId);if(error)throw error;location.href=data.redirect_url}catch(e){el('consentStatus').textContent=e?.message||String(e);el('consentStatus').className='status error';el('deny').disabled=false}};load();</script></body></html>`;

const previewHtml = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/><meta name="color-scheme" content="dark"/><title>CryptoBot Control Center</title><style>html,body,#cryptobot-root{margin:0;min-height:100%;width:100%;background:#07111f;color:#eef4ff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}#gate{min-height:100vh;display:grid;place-items:center;padding:18px;background:radial-gradient(circle at 82% -10%,rgba(85,166,255,.14),transparent 34%),#07111f}.gate-card{width:min(100%,500px);padding:22px;border:1px solid #20324a;border-radius:20px;background:#0b1728;box-shadow:0 20px 60px rgba(0,0,0,.35)}.brand{display:flex;align-items:center;gap:12px}.logo{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(145deg,#2a81ff,#7762ff);font-weight:900}.muted{color:#8fa3bf;font-size:12px;line-height:1.55}.notice{margin:16px 0;padding:11px 12px;border:1px solid rgba(54,211,153,.25);border-radius:12px;background:rgba(54,211,153,.06);color:#c6f5e3;font-size:11px}input{width:100%;box-sizing:border-box;margin-top:10px;padding:12px;border-radius:11px;border:1px solid #20324a;background:#071522;color:#fff}.btn{width:100%;margin-top:10px;padding:12px;border:0;border-radius:11px;background:linear-gradient(145deg,#267cff,#625cff);color:#fff;font-weight:800}.status{margin-top:10px;font-size:11px;color:#8fa3bf}.error{color:#ffb6bf}.hidden{display:none!important}#previewBadge{position:fixed;z-index:9999;left:12px;top:12px;padding:6px 9px;border:1px solid rgba(54,211,153,.3);border-radius:999px;background:rgba(5,18,31,.9);color:#8ef0c8;font-size:10px;backdrop-filter:blur(8px)}</style></head><body><div id="gate"><div class="gate-card"><div class="brand"><div class="logo">CB</div><div><strong>CryptoBot Control Center</strong><div class="muted">Secure Mobile Preview · Read-Only</div></div></div><div class="notice">המסך מציג את אותו Widget שמיועד ל־ChatGPT. נתוני החשבון נטענים רק לאחר אימות Supabase ובדיקת ה־allow-list הפרטי.</div><div id="checking" class="muted">בודק התחברות…</div><div id="login" class="hidden"><input id="email" type="email" autocomplete="email" placeholder="כתובת האימייל שלך"/><button id="send" class="btn">שלח קישור התחברות חד־פעמי</button><div id="status" class="status"></div></div><div id="denied" class="hidden status error">החשבון מאומת אך אינו מורשה לצפות ב־CryptoBot.</div></div></div><div id="previewBadge" class="hidden">SECURE PREVIEW · READ ONLY</div><div id="cryptobot-root" class="hidden"></div><script type="module">import{createClient}from'https://esm.sh/@supabase/supabase-js@2.55.0';const PROJECT_URL=${escapeJsonForScript(PROJECT_URL)},KEY=${escapeJsonForScript(PUBLISHABLE_KEY)},BASE=${escapeJsonForScript(baseUrl)},supabase=createClient(PROJECT_URL,KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce'}}),el=id=>document.getElementById(id);async function restoreCode(){const q=new URLSearchParams(location.search),code=q.get('code');if(!code)return;const{error}=await supabase.auth.exchangeCodeForSession(code);if(error)throw error;q.delete('code');history.replaceState({},'',location.pathname+(q.size?'?'+q.toString():''))}async function api(name,args={}){const{data:{session}}=await supabase.auth.getSession();if(!session?.access_token)throw new Error('authentication_required');const r=await fetch(BASE+'/preview-api',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+session.access_token},body:JSON.stringify({name,args}),cache:'no-store'});if(r.status===401)throw new Error('not_allowed');if(!r.ok){const body=await r.json().catch(()=>({}));throw new Error(body.error||'preview_api_failed')}return await r.json()}function installHost(bootstrap){let widgetState={};try{widgetState=JSON.parse(localStorage.getItem('cryptobot_widget_state')||'{}')}catch{}window.openai={toolOutput:bootstrap,widgetState,setWidgetState(state){widgetState=state||{};this.widgetState=widgetState;localStorage.setItem('cryptobot_widget_state',JSON.stringify(widgetState))},async callTool(name,args){return{structuredContent:await api(name,args||{})}},async requestDisplayMode({mode}){if(mode==='fullscreen'&&document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();return{mode}}}}async function boot(){try{await restoreCode();const{data:{session}}=await supabase.auth.getSession();if(!session){el('checking').classList.add('hidden');el('login').classList.remove('hidden');return}const bootstrap=await api('open_control_center');installHost(bootstrap);el('gate').classList.add('hidden');el('cryptobot-root').classList.remove('hidden');el('previewBadge').classList.remove('hidden');await import(BASE+'/widget.js?v='+${escapeJsonForScript(VERIFIED_WIDGET_COMMIT)})}catch(e){el('checking').classList.add('hidden');if(String(e?.message||e)==='not_allowed'){el('denied').classList.remove('hidden')}else{el('login').classList.remove('hidden');el('status').textContent=e?.message||String(e);el('status').className='status error'}}}el('send').onclick=async()=>{const email=el('email').value.trim();if(!email)return;el('send').disabled=true;el('status').textContent='שולח קישור…';try{const{error}=await supabase.auth.signInWithOtp({email,options:{shouldCreateUser:false}});if(error)throw error;el('status').textContent='הקישור נשלח. פתח אותו במייל — תחזור אוטומטית ל־CryptoBot.'}catch(e){el('status').textContent=e?.message||String(e);el('status').className='status error'}finally{el('send').disabled=false}};boot();</script></body></html>`;

const app = new Hono().basePath(`/${FUNCTION_NAME}`);

app.get("/health", (c) => c.json({
  ok: true,
  service: "cryptobot-oauth",
  mode: "oauth_consent_and_secure_preview",
  preview: "/preview",
  widget_commit: VERIFIED_WIDGET_COMMIT,
}));

app.get("/consent", (c) => new Response(consentHtml, {
  headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders },
}));

app.get("/preview", (c) => new Response(previewHtml, {
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; script-src 'self' https://esm.sh; style-src 'unsafe-inline'; connect-src 'self' ${PROJECT_URL}; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    ...securityHeaders,
  },
}));

app.get("/widget.js", () => new Response(widgetBundle, {
  headers: {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  },
}));

app.post("/preview-api", async (c) => {
  const principal = await principalFor(c.req.raw);
  if (!principal) return unauthorized();
  let body: { name?: unknown; args?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400, securityHeaders);
  }
  const name = typeof body.name === "string" ? body.name : "";
  if (!isStandalonePreviewTool(name)) return c.json({ error: "tool_not_allowed" }, 403, securityHeaders);
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
  try {
    const data = await runPreviewTool(principal, name, args);
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", ...securityHeaders },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "preview_tool_failed";
    return c.json({ error: message }, message === "invalid_decision_id" ? 400 : 500, securityHeaders);
  }
});

app.get("/", (c) => {
  const url = new URL(c.req.url);
  const destination = url.searchParams.has("authorization_id") ? "/consent" : "/preview";
  return c.redirect(`${baseUrl}${destination}${url.search}`);
});

Deno.serve(app.fetch);
