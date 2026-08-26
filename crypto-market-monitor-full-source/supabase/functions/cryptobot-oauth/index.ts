import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "npm:hono@4.9.12";

const FUNCTION_NAME = "cryptobot-oauth";
const PROJECT_URL = "https://xabffbjifmnoogzcttyd.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_-0xlsgjpG-xwVfaUGTag4A_wvgxVWwD";

const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CryptoBot — אישור גישה</title>
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color-scheme:dark;--bg:#06101d;--panel:#0b1828;--line:#21374f;--muted:#91a6c0;--text:#f0f6ff;--brand:#5baaff;--good:#36d399;--bad:#ff6b7a}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}body{display:grid;place-items:center;padding:18px;background:radial-gradient(circle at 80% 0%,rgba(91,170,255,.15),transparent 34%),var(--bg)}.card{width:min(100%,520px);padding:24px;border:1px solid rgba(94,132,173,.25);background:linear-gradient(180deg,#0d1d30,#081624);border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.35)}.brand{display:flex;align-items:center;gap:12px;margin-bottom:20px}.logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(145deg,#2a81ff,#7762ff);display:grid;place-items:center;font-weight:900}.brand h1{margin:0;font-size:20px}.brand p{margin:4px 0 0;color:var(--muted);font-size:11px}.notice{padding:11px 12px;border:1px solid rgba(54,211,153,.2);background:rgba(54,211,153,.06);border-radius:12px;font-size:11px;line-height:1.55;color:#c6f5e3;margin-bottom:16px}.muted{color:var(--muted);font-size:11px;line-height:1.55}.box{padding:14px;border:1px solid var(--line);border-radius:13px;background:rgba(4,14,25,.5);margin:12px 0}.label{font-size:10px;color:var(--muted);margin-bottom:5px}.value{font-size:13px;font-weight:700;word-break:break-word}.scopes{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.scope{padding:5px 8px;border:1px solid var(--line);border-radius:999px;font-size:10px;color:#c5d7ea}.actions{display:flex;gap:8px;margin-top:16px}.btn{flex:1;border:1px solid var(--line);border-radius:11px;padding:11px 12px;cursor:pointer;background:#0a1c30;color:white;font-weight:700}.btn.primary{background:linear-gradient(145deg,#267cff,#625cff);border-color:transparent}.btn.danger{color:#ffc2c8;border-color:rgba(255,107,122,.35)}input{width:100%;margin-top:7px;padding:12px;border:1px solid var(--line);border-radius:10px;background:#071522;color:white;outline:none}.status{margin-top:12px;font-size:11px;line-height:1.5}.error{color:#ffb6bf}.good{color:var(--good)}.hidden{display:none}.footer{text-align:center;color:var(--muted);font-size:9px;margin-top:16px}@media(max-width:520px){body{padding:10px}.card{padding:18px;border-radius:17px}.actions{flex-direction:column}}</style>
</head>
<body>
<main class="card">
  <div class="brand"><div class="logo">CB</div><div><h1>CryptoBot</h1><p>אישור גישה פרטי ל־ChatGPT Control Center</p></div></div>
  <div class="notice">החיבור מאפשר <strong>קריאה בלבד</strong> של נתוני CryptoBot. אין בו כלי לפתיחת עסקה, שינוי פקודה, העברת כספים או משיכה.</div>
  <div id="loading" class="muted">בודק את בקשת ההרשאה…</div>
  <section id="login" class="hidden">
    <div class="muted">כדי לאשר את ChatGPT, התחבר לחשבון CryptoBot באמצעות קישור חד־פעמי למייל.</div>
    <label><div class="label" style="margin-top:14px">כתובת אימייל</div><input id="email" type="email" autocomplete="email" placeholder="name@example.com" /></label>
    <button id="send" class="btn primary" style="width:100%;margin-top:10px">שלח קישור התחברות</button>
    <div id="loginStatus" class="status"></div>
  </section>
  <section id="consent" class="hidden">
    <div class="box"><div class="label">האפליקציה המבקשת גישה</div><div id="clientName" class="value">ChatGPT</div></div>
    <div class="box"><div class="label">Redirect URI</div><div id="redirectUri" class="value"></div></div>
    <div class="box"><div class="label">הרשאות מבוקשות</div><div id="scopes" class="scopes"></div></div>
    <div class="muted">CryptoBot יאמת בנוסף שהמשתמש נמצא ב־allow-list הפרטי של הפרויקט בכל קריאת MCP.</div>
    <div class="actions"><button id="approve" class="btn primary">אשר גישה</button><button id="deny" class="btn danger">דחה</button></div>
    <div id="consentStatus" class="status"></div>
  </section>
  <section id="fatal" class="hidden"><div id="fatalText" class="status error"></div></section>
  <div class="footer">CryptoBot OAuth · Supabase Auth · Read-Only MCP</div>
</main>
<script type="module">
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
const PROJECT_URL=${JSON.stringify(PROJECT_URL)};
const KEY=${JSON.stringify(PUBLISHABLE_KEY)};
const supabase=createClient(PROJECT_URL,KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce'}});
const qs=new URLSearchParams(location.search);
const authorizationId=qs.get('authorization_id');
const el=id=>document.getElementById(id);
function show(id){['loading','login','consent','fatal'].forEach(x=>el(x).classList.toggle('hidden',x!==id))}
function fatal(message){show('fatal');el('fatalText').textContent=message}
async function restoreCode(){const code=qs.get('code');if(!code)return;const {error}=await supabase.auth.exchangeCodeForSession(code);if(error)throw error;qs.delete('code');history.replaceState({},'',location.pathname+'?'+qs.toString())}
async function load(){try{if(!authorizationId)return fatal('חסר authorization_id. יש לפתוח את הדף דרך תהליך OAuth של ChatGPT.');await restoreCode();const {data:{user}}=await supabase.auth.getUser();if(!user){show('login');return}const {data,error}=await supabase.auth.oauth.getAuthorizationDetails(authorizationId);if(error)throw error;if(data?.redirect_url&&!data?.authorization_id){location.href=data.redirect_url;return}if(!data?.authorization_id)throw new Error('בקשת ההרשאה אינה זמינה');el('clientName').textContent=data.client?.name||'ChatGPT MCP Client';el('redirectUri').textContent=data.redirect_uri||'לא זמין';const scopes=String(data.scope||'email').split(/\s+/).filter(Boolean);el('scopes').innerHTML=scopes.map(x=>'<span class="scope">'+x.replace(/[<>&]/g,'')+'</span>').join('');show('consent')}catch(e){fatal(e?.message||String(e))}}
el('send').onclick=async()=>{const email=el('email').value.trim();if(!email){el('loginStatus').textContent='יש להזין אימייל.';el('loginStatus').className='status error';return}el('send').disabled=true;el('loginStatus').textContent='שולח קישור…';try{const redirectTo=location.href;const {error}=await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:redirectTo,shouldCreateUser:false}});if(error)throw error;el('loginStatus').textContent='נשלח קישור חד־פעמי. פתח אותו במייל כדי לחזור למסך האישור.';el('loginStatus').className='status good'}catch(e){el('loginStatus').textContent=e?.message||String(e);el('loginStatus').className='status error'}finally{el('send').disabled=false}};
el('approve').onclick=async()=>{el('approve').disabled=true;el('consentStatus').textContent='מאשר…';try{const {data,error}=await supabase.auth.oauth.approveAuthorization(authorizationId);if(error)throw error;location.href=data.redirect_url}catch(e){el('consentStatus').textContent=e?.message||String(e);el('consentStatus').className='status error';el('approve').disabled=false}};
el('deny').onclick=async()=>{el('deny').disabled=true;try{const {data,error}=await supabase.auth.oauth.denyAuthorization(authorizationId);if(error)throw error;location.href=data.redirect_url}catch(e){el('consentStatus').textContent=e?.message||String(e);el('consentStatus').className='status error';el('deny').disabled=false}};
load();
</script>
</body>
</html>`;

const app = new Hono().basePath(`/${FUNCTION_NAME}`);
app.get("/health", (c) => c.json({ ok: true, service: "cryptobot-oauth", mode: "consent_ui" }));
app.get("/consent", (c) => c.html(html));
app.get("/", (c) => c.redirect(`/${FUNCTION_NAME}/consent${c.req.url.includes("?") ? `?${c.req.url.split("?")[1]}` : ""}`));
Deno.serve(app.fetch);
