import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "npm:hono@4.9.12";

const PROJECT_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const PUBLISHABLE_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const VERIFIED_WIDGET_COMMIT = "1587000700feeddab50e362310c678e8680c707b";
const OAUTH_BASE = `${PROJECT_URL}/functions/v1/cryptobot-oauth`;
const PREVIEW_URL = `${PROJECT_URL}/functions/v1/cryptobot-preview`;

if (!PROJECT_URL || !PUBLISHABLE_KEY) throw new Error("supabase_runtime_config_missing");

function json(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<title>CryptoBot Control Center</title>
<style>
html,body,#cryptobot-root{margin:0;min-height:100%;width:100%;background:#07111f;color:#eef4ff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
#gate{min-height:100vh;display:grid;place-items:center;padding:18px;background:radial-gradient(circle at 82% -10%,rgba(85,166,255,.14),transparent 34%),#07111f}
.gate-card{width:min(100%,500px);padding:22px;border:1px solid #20324a;border-radius:20px;background:#0b1728;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.brand{display:flex;align-items:center;gap:12px}.logo{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(145deg,#2a81ff,#7762ff);font-weight:900}.muted{color:#8fa3bf;font-size:12px;line-height:1.55}.notice{margin:16px 0;padding:11px 12px;border:1px solid rgba(54,211,153,.25);border-radius:12px;background:rgba(54,211,153,.06);color:#c6f5e3;font-size:11px}input{width:100%;box-sizing:border-box;margin-top:10px;padding:12px;border-radius:11px;border:1px solid #20324a;background:#071522;color:#fff}.btn{width:100%;margin-top:10px;padding:12px;border:0;border-radius:11px;background:linear-gradient(145deg,#267cff,#625cff);color:#fff;font-weight:800}.status{margin-top:10px;font-size:11px;color:#8fa3bf}.error{color:#ffb6bf}.good{color:#8ef0c8}.hidden{display:none!important}#previewBadge{position:fixed;z-index:9999;left:12px;top:12px;padding:6px 9px;border:1px solid rgba(54,211,153,.3);border-radius:999px;background:rgba(5,18,31,.9);color:#8ef0c8;font-size:10px;backdrop-filter:blur(8px)}
</style>
</head>
<body>
<div id="gate"><div class="gate-card"><div class="brand"><div class="logo">CB</div><div><strong>CryptoBot Control Center</strong><div class="muted">Secure Mobile Preview · Read-Only</div></div></div><div class="notice">זהו אותו Widget שמיועד ל־ChatGPT. נתונים נטענים רק לאחר Supabase Auth ובדיקת ה־allow-list הפרטי.</div><div id="checking" class="muted">בודק התחברות…</div><div id="login" class="hidden"><input id="email" type="email" autocomplete="email" placeholder="כתובת האימייל שלך"/><button id="send" class="btn">שלח קישור התחברות חד־פעמי</button><div id="status" class="status"></div></div><div id="denied" class="hidden status error">החשבון מאומת אך אינו מורשה לצפות ב־CryptoBot.</div></div></div>
<div id="previewBadge" class="hidden">SECURE PREVIEW · READ ONLY</div>
<div id="cryptobot-root" class="hidden"></div>
<script type="module">
import{createClient}from'https://esm.sh/@supabase/supabase-js@2.55.0';
const PROJECT_URL=${json(PROJECT_URL)},KEY=${json(PUBLISHABLE_KEY)},OAUTH_BASE=${json(OAUTH_BASE)},PREVIEW_URL=${json(PREVIEW_URL)},COMMIT=${json(VERIFIED_WIDGET_COMMIT)};
const supabase=createClient(PROJECT_URL,KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce'}}),el=id=>document.getElementById(id);
async function restoreCode(){const q=new URLSearchParams(location.search),code=q.get('code');if(!code)return;const{error}=await supabase.auth.exchangeCodeForSession(code);if(error)throw error;q.delete('code');history.replaceState({},'',location.pathname+(q.size?'?'+q.toString():''))}
async function api(name,args={}){const{data:{session}}=await supabase.auth.getSession();if(!session?.access_token)throw new Error('authentication_required');const r=await fetch(OAUTH_BASE+'/preview-api',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+session.access_token},body:JSON.stringify({name,args}),cache:'no-store'});if(r.status===401||r.status===403)throw new Error('not_allowed');if(!r.ok){const body=await r.json().catch(()=>({}));throw new Error(body.error||'preview_api_failed')}return await r.json()}
function installHost(bootstrap){let widgetState={};try{widgetState=JSON.parse(localStorage.getItem('cryptobot_widget_state')||'{}')}catch{}window.openai={toolOutput:bootstrap,widgetState,setWidgetState(state){widgetState=state||{};this.widgetState=widgetState;localStorage.setItem('cryptobot_widget_state',JSON.stringify(widgetState))},async callTool(name,args){return{structuredContent:await api(name,args||{})}},async requestDisplayMode({mode}){if(mode==='fullscreen'&&document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();return{mode}}}}
async function boot(){try{await restoreCode();const{data:{session}}=await supabase.auth.getSession();if(!session){el('checking').classList.add('hidden');el('login').classList.remove('hidden');return}const bootstrap=await api('open_control_center');installHost(bootstrap);el('gate').classList.add('hidden');el('cryptobot-root').classList.remove('hidden');el('previewBadge').classList.remove('hidden');await import(OAUTH_BASE+'/widget.js?v='+COMMIT)}catch(e){el('checking').classList.add('hidden');if(String(e?.message||e)==='not_allowed'){el('denied').classList.remove('hidden');return}el('login').classList.remove('hidden');el('status').textContent=e?.message||String(e);el('status').className='status error'}}
el('send').onclick=async()=>{const email=el('email').value.trim();if(!email){el('status').textContent='יש להזין אימייל.';el('status').className='status error';return}el('send').disabled=true;el('status').textContent='שולח קישור…';el('status').className='status';try{const{error}=await supabase.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:PREVIEW_URL}});if(error)throw error;el('status').textContent='נשלח קישור חד־פעמי. פתח אותו במייל וחזור לכאן.';el('status').className='status good'}catch(e){el('status').textContent=e?.message||String(e);el('status').className='status error'}finally{el('send').disabled=false}};
boot();
</script>
</body>
</html>`;

const app = new Hono().basePath("/cryptobot-preview");
app.get("/health", (c) => c.json({ ok: true, service: "cryptobot-preview", mode: "secure_read_only", widget_commit: VERIFIED_WIDGET_COMMIT }));
app.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Content-Security-Policy", `default-src 'none'; script-src 'unsafe-inline' https://esm.sh ${PROJECT_URL}; style-src 'unsafe-inline'; connect-src ${PROJECT_URL} https://esm.sh; img-src data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  return c.html(html);
});

Deno.serve(app.fetch);
