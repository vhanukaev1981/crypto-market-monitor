"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type User } from "@supabase/supabase-js";

const supabase = createClient(
  "https://xabffbjifmnoogzcttyd.supabase.co",
  "sb_publishable_-0xlsgjpG-xwVfaUGTag4A_wvgxVWwD",
);

type RuntimeRow = {
  platform_bot_id: string;
  display_name: string;
  bot_key: string;
  legacy_environment: string | null;
  legacy_category: string | null;
  runtime_health_status: string;
  latest_run_status: string | null;
  latest_run_reason: string | null;
  latest_run_started_at: string | null;
  latest_run_ended_at: string | null;
  completed_runs_24h: number;
  failed_runs_24h: number;
  open_positions: number;
  unprotected_positions: number;
  exchange_open_orders: number;
  orders_24h: number;
  private_stream_status: string;
  private_stream_error: string | null;
  private_stream_updated_at: string | null;
  smart_exit_status: string;
  snapshot_status: string;
  snapshot_error: string | null;
  snapshot_checked_at: string | null;
  latest_risk_severity: string | null;
  latest_risk_code: string | null;
  latest_risk_message: string | null;
  latest_risk_at: string | null;
  observed_at: string;
};

const css = `
.runtime{direction:rtl;color:#edf7ff;padding:18px 22px 32px}.runtime-shell{display:grid;gap:14px}.runtime-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.runtime h1{margin:0;font-size:clamp(26px,4vw,42px);letter-spacing:-.04em}.runtime-sub{color:#88a2b8;line-height:1.65;max-width:820px}.refresh{border:1px solid #1d425a;background:#091a29;color:#dff7ff;border-radius:11px;padding:10px 14px;font:inherit;font-size:12px;font-weight:850;cursor:pointer}.refresh:disabled{opacity:.55}.metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.metric,.card,.notice{border:1px solid #17344e;background:linear-gradient(180deg,rgba(12,30,50,.94),rgba(7,18,32,.96));border-radius:15px}.metric{padding:14px}.metric span{display:block;color:#849eb3;font-size:11px;margin-bottom:7px}.metric strong{font-size:24px;direction:ltr;display:block;text-align:right}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.card{padding:17px}.card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:13px}.card h2{margin:0;font-size:17px}.meta{color:#7692a8;font-size:10px;margin-top:4px;direction:ltr}.pill{display:inline-flex;border:1px solid #27475c;background:#0a1a28;border-radius:999px;padding:5px 9px;font-size:10px;font-weight:900;white-space:nowrap}.pill.good{color:#59efbb;border-color:rgba(89,239,187,.28);background:rgba(89,239,187,.07)}.pill.bad{color:#ff899b;border-color:rgba(255,137,155,.3);background:rgba(255,137,155,.07)}.pill.warn{color:#ffc66f;border-color:rgba(255,198,111,.28);background:rgba(255,198,111,.06)}.rows{display:grid;gap:8px}.row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid rgba(39,72,94,.52);padding-top:8px;font-size:11px}.row:first-child{border-top:0;padding-top:0}.row span{color:#86a0b5}.value{direction:ltr;text-align:left;font-weight:800}.notice{padding:14px;color:#8da7bb;font-size:12px;line-height:1.6}.error{border-color:rgba(255,122,143,.35);color:#ff9aaa;background:rgba(255,122,143,.07)}.empty{min-height:260px;display:grid;place-items:center;text-align:center}.loading{min-height:55vh;display:grid;place-items:center;color:#89a3b7}.risk{margin-top:13px;border:1px solid rgba(255,184,92,.25);background:rgba(255,184,92,.055);border-radius:11px;padding:10px;color:#f1c987;font-size:10px;line-height:1.55}.risk strong{display:block;color:#ffd99e;margin-bottom:4px}.footer{color:#5f7c92;font-size:10px;text-align:center;padding-top:8px}@media(max-width:1200px){.metrics{grid-template-columns:repeat(3,1fr)}.cards{grid-template-columns:repeat(2,1fr)}}@media(max-width:760px){.runtime{padding:14px}.runtime-head{flex-direction:column}.metrics{grid-template-columns:repeat(2,1fr)}.cards{grid-template-columns:1fr}}@media(max-width:430px){.metrics{grid-template-columns:1fr}}
`;

const label: Record<string,string> = {
  healthy:"תקין", stream_warning:"אזהרת Stream", data_delayed:"נתונים מתעכבים",
  live_locked:"Live נעול", stopped:"עצור", stale:"מיושן", error:"שגיאה",
  never_run:"טרם רץ", protection_warning:"אזהרת הגנה", not_applicable:"לא רלוונטי",
  stale_or_disconnected:"מנותק או מיושן", missing:"חסר", idle:"ללא פוזיציה",
  active_observed:"פעיל ונצפה", protected_observed:"הגנות נצפו",
  native_futures_protection:"הגנות Native Futures", completed:"הושלם", failed:"נכשל",
};
const text=(v:unknown,f="לא זמין")=>v===null||v===undefined||v===""?f:String(v);
const number=(v:unknown)=>Number.isFinite(Number(v))?Number(v):0;
const dt=(v:unknown)=>v?new Date(String(v)).toLocaleString("he-IL",{dateStyle:"short",timeStyle:"short"}):"לא זמין";
const tone=(v:unknown)=>{const s=text(v,"");if(["healthy","completed","active_observed","protected_observed","native_futures_protection","idle"].includes(s))return"good";if(["error","failed","protection_warning"].includes(s))return"bad";return"warn"};
function Pill({value}:{value:unknown}){const key=text(value,"");return <span className={`pill ${tone(key)}`}>{label[key]??text(value)}</span>}
function Metric({name,value}:{name:string;value:number}){return <div className="metric"><span>{name}</span><strong>{value}</strong></div>}

export default function RuntimeObservationPage(){
  const [user,setUser]=useState<User|null>(null);
  const [ready,setReady]=useState(false);
  const [rows,setRows]=useState<RuntimeRow[]>([]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [updated,setUpdated]=useState<Date|null>(null);

  useEffect(()=>{
    let active=true;
    supabase.auth.getUser().then(({data})=>{if(active){setUser(data.user);setReady(true)}});
    const {data}=supabase.auth.onAuthStateChange((_event,session)=>{setUser(session?.user??null);setReady(true)});
    return()=>{active=false;data.subscription.unsubscribe()};
  },[]);

  const load=useCallback(async()=>{
    if(!user)return;
    setLoading(true);setError("");
    const result=await supabase.from("platform_runtime_observation").select("*").order("display_name");
    if(result.error)setError(result.error.message);
    else setRows((result.data??[]) as RuntimeRow[]);
    setUpdated(new Date());setLoading(false);
  },[user]);

  useEffect(()=>{if(!user)return;void load();const id=window.setInterval(()=>void load(),20_000);return()=>window.clearInterval(id)},[user,load]);

  const metrics=useMemo(()=>({
    healthy:rows.filter(r=>r.runtime_health_status==="healthy").length,
    warnings:rows.filter(r=>!["healthy","live_locked","stopped"].includes(r.runtime_health_status)).length,
    positions:rows.reduce((s,r)=>s+number(r.open_positions),0),
    orders:rows.reduce((s,r)=>s+number(r.exchange_open_orders),0),
    failed:rows.reduce((s,r)=>s+number(r.failed_runs_24h),0),
    unprotected:rows.reduce((s,r)=>s+number(r.unprotected_positions),0),
  }),[rows]);

  if(!ready)return <main className="runtime"><style>{css}</style><div className="loading">בודק הרשאה…</div></main>;
  if(!user)return <main className="runtime"><style>{css}</style><div className="notice error">נדרשת התחברות דרך Trading OS.</div></main>;

  return <main className="runtime"><style>{css}</style><div className="runtime-shell">
    <header className="runtime-head"><div><h1>Runtime Observation</h1><p className="runtime-sub">תמונת מצב חיה לקריאה בלבד של מנועי המסחר, ריצות, Streams, הגנות, פוזיציות, פקודות ואירועי סיכון. המסך אינו משנה הגדרות ואינו שולח פקודות.</p></div><button className="refresh" onClick={()=>void load()} disabled={loading}>{loading?"מרענן…":"רענון"}</button></header>
    <div className="notice">עדכון אחרון: <strong>{updated?updated.toLocaleTimeString("he-IL"):"טרם נטען"}</strong> · רענון אוטומטי כל 20 שניות.</div>
    {error&&<div className="notice error">הנתונים לא נטענו: <span dir="ltr">{error}</span></div>}
    <section className="metrics"><Metric name="מנועים תקינים" value={metrics.healthy}/><Metric name="אזהרות פעילות" value={metrics.warnings}/><Metric name="פוזיציות פתוחות" value={metrics.positions}/><Metric name="פקודות פתוחות בבורסה" value={metrics.orders}/><Metric name="ריצות שנכשלו 24ש׳" value={metrics.failed}/><Metric name="פוזיציות ללא הגנה" value={metrics.unprotected}/></section>
    {rows.length===0&&!loading?<div className="notice empty">לא נמצאו מנועים ממופים.</div>:<section className="cards">{rows.map(row=><article className="card" key={row.platform_bot_id}>
      <div className="card-head"><div><h2>{row.display_name}</h2><div className="meta">{row.bot_key} · {text(row.legacy_environment)} · {text(row.legacy_category)}</div></div><Pill value={row.runtime_health_status}/></div>
      <div className="rows">
        <div className="row"><span>ריצה אחרונה</span><strong className="value">{dt(row.latest_run_ended_at??row.latest_run_started_at)}</strong></div>
        <div className="row"><span>סטטוס ריצה</span><strong className="value"><Pill value={row.latest_run_status??"never_run"}/></strong></div>
        <div className="row"><span>ריצות 24 שעות</span><strong className="value">{number(row.completed_runs_24h)} תקינות / {number(row.failed_runs_24h)} כשלו</strong></div>
        <div className="row"><span>פוזיציות / ללא הגנה</span><strong className="value">{number(row.open_positions)} / {number(row.unprotected_positions)}</strong></div>
        <div className="row"><span>פקודות פתוחות בבורסה</span><strong className="value">{number(row.exchange_open_orders)}</strong></div>
        <div className="row"><span>פקודות ב־24 שעות</span><strong className="value">{number(row.orders_24h)}</strong></div>
        <div className="row"><span>Private Stream</span><strong className="value"><Pill value={row.private_stream_status}/></strong></div>
        <div className="row"><span>Smart Exit</span><strong className="value"><Pill value={row.smart_exit_status}/></strong></div>
        <div className="row"><span>Snapshot</span><strong className="value"><Pill value={row.snapshot_status}/></strong></div>
      </div>
      {(row.latest_run_reason||row.private_stream_error||row.snapshot_error)&&<div className="risk"><strong>שגיאה פעילה</strong>{text(row.latest_run_reason??row.private_stream_error??row.snapshot_error)}</div>}
      {row.latest_risk_code&&<div className="risk"><strong>אירוע סיכון אחרון: {row.latest_risk_code}</strong>{text(row.latest_risk_message)}<br/>{dt(row.latest_risk_at)}</div>}
    </article>)}</section>}
    <footer className="footer">Platform V2 · Runtime Observation · Read-only</footer>
  </div></main>;
}
