import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AlgoBotStatus,
  BybitBotsOutput,
  ControlCenterBootstrap,
  DashboardOverview,
  DecisionExplanation,
  PortfolioOutput,
  RiskStatus,
  SystemHealth,
} from "../../../src/cryptobot/domain.ts";
import {
  callCryptoBotTool,
  canRequestFullscreen,
  readWidgetState,
  requestFullscreen,
  subscribeToolResults,
  writeWidgetState,
} from "./bridge.ts";
import { ageLabel, freshnessHebrew, money, modeHebrew, percent, pnlClass, systemStateHebrew } from "./format.ts";
import { styles } from "./styles.ts";

type Tab = "overview" | "algobot" | "bybit" | "portfolio" | "risk" | "system";
type WidgetState = { tab?: Tab };

const TAB_LABELS: Record<Tab, string> = {
  overview: "סקירה כללית",
  algobot: "AlgoBot",
  bybit: "בוטים של Bybit",
  portfolio: "תיק ועסקאות",
  risk: "ניהול סיכון",
  system: "מצב המערכת",
};

function safeBootstrap(value: unknown): ControlCenterBootstrap | null {
  if (!value || typeof value !== "object" || !("overview" in value)) return null;
  return value as ControlCenterBootstrap;
}

function Kpi({ label, value, sub, className = "neutral" }: { label: string; value: string; sub?: string; className?: string }) {
  return <div className="card kpi"><div className="kpi-label">{label}</div><div className={`kpi-value ${className}`}>{value}</div>{sub ? <div className="kpi-sub">{sub}</div> : null}</div>;
}

function StatePill({ state, label }: { state: "good" | "warn" | "bad"; label: string }) {
  return <span className={`state ${state}`}>{label}</span>;
}

function SourceCards({ overview }: { overview: DashboardOverview }) {
  const entries = Object.entries(overview.sources ?? {});
  if (!entries.length) return null;
  return <div className="source-grid">{entries.map(([key, meta]) => {
    const state = meta.source_state === "ok" && meta.freshness_state === "fresh" ? "good" : meta.source_state === "fault" || meta.freshness_state === "stale" ? "bad" : "warn";
    return <div className="source-card" key={key}><div className="source-name">{key}</div><div className="source-meta"><span>{freshnessHebrew(meta.freshness_state)}</span><StatePill state={state} label={ageLabel(meta.age_seconds)} /></div></div>;
  })}</div>;
}

function OverviewView({ data, onExplain }: { data: ControlCenterBootstrap; onExplain: (id: string) => void }) {
  const o = data.overview;
  const latest = o.latest_decision;
  const overall = o.system_state === "healthy" ? "good" : o.system_state === "emergency_stop" ? "bad" : "warn";
  return <>
    <div className="kpis">
      <Kpi label="שווי תיק כולל" value={money(o.portfolio_equity_usd)} sub="Bybit Mainnet · קריאה בלבד" />
      <Kpi label="רווח/הפסד היום" value={money(o.pnl.day_usd)} className={pnlClass(o.pnl.day_usd)} sub={`שבוע: ${money(o.pnl.week_usd)} · חודש: ${money(o.pnl.month_usd)}`} />
      <Kpi label="פוזיציות פתוחות" value={o.open_positions === null ? "לא זמין" : String(o.open_positions)} sub={`הון בפריסה: ${percent(o.deployed_capital_pct)}`} />
      <Kpi label="מצב המערכת" value={systemStateHebrew(o.system_state)} className={overall === "good" ? "positive" : overall === "bad" ? "negative" : "neutral"} sub={`Drawdown: ${percent(o.drawdown_pct)}`} />
    </div>
    <div className="grid2">
      <section className="card panel">
        <div className="panel-head"><div><div className="panel-title">צינור ההחלטה של AlgoBot</div><div className="panel-sub">האסטרטגיה אינה שולחת פקודה ישירות לבורסה</div></div><span className="panel-badge">Read-Only UI</span></div>
        <div className="flow">
          {["נתוני שוק","אסטרטגיה","מנוע סיכון","מנהל פקודות","ביצוע"].map((x, i) => <div key={x} className={`stage ${i < 3 ? "active" : ""}`}><strong>{x}</strong><span>{i === 0 ? "Market Data" : i === 1 ? `${o.algobot.active_strategies ?? 0} אסטרטגיות` : i === 2 ? "Guardrails" : i === 3 ? "Order Plan" : "Mode Gate"}</span></div>)}
        </div>
      </section>
      <section className="card panel">
        <div className="panel-head"><div><div className="panel-title">החלטה אחרונה</div><div className="panel-sub">הסבר מבוסס עובדות שמורות בלבד</div></div></div>
        {latest ? <div className="decision"><div className="decision-icon">AI</div><div className="decision-main"><div className="decision-title"><span>{latest.symbol ?? "סמל לא זמין"}</span><StatePill state={latest.decision.toLowerCase().includes("reject") || latest.decision.toLowerCase().includes("hold") ? "warn" : "good"} label={latest.decision} /></div><div className="decision-reason">{latest.reason ?? "לא נשמר נימוק מפורט"}</div><div className="decision-meta"><span>{latest.strategy ?? "אסטרטגיה לא ידועה"}</span><span>{latest.observed_at ? new Date(latest.observed_at).toLocaleString("he-IL") : "זמן לא ידוע"}</span><button className="refreshbtn" onClick={() => onExplain(latest.id)}>למה?</button></div></div></div> : <div className="empty"><div><strong>אין החלטה זמינה כרגע</strong><span>המסך לא ממציא החלטות כשאין מקור שמור.</span></div></div>}
      </section>
    </div>
    <div className="grid2">
      <section className="card panel"><div className="panel-head"><div><div className="panel-title">פעילות ומקורות</div><div className="panel-sub">טריות הנתונים מוצגת לכל מקור בנפרד</div></div></div><SourceCards overview={o} /></section>
      <section className="card panel"><div className="panel-head"><div><div className="panel-title">התראות</div><div className="panel-sub">רק אירועים שדורשים תשומת לב</div></div></div><div className="list">{o.alerts.length ? o.alerts.slice(0,5).map(a => <div className="row" key={a.id}><div className="row-main"><div className="row-title">{a.title}</div><div className="row-sub">{a.message}</div></div><StatePill state={a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : "good"} label={a.severity} /></div>) : <div className="empty"><div><strong>אין התראות פעילות</strong><span>לא זוהה אירוע שמחייב טיפול.</span></div></div>}</div></section>
    </div>
  </>;
}

function AlgoView({ data }: { data?: AlgoBotStatus }) {
  if (!data) return <Empty title="נתוני AlgoBot עדיין לא נטענו" />;
  return <section className="card panel"><div className="panel-head"><div><div className="panel-title">אסטרטגיות AlgoBot</div><div className="panel-sub">ביצועים, מצב, אות אחרון ומצב קידום</div></div><span className="panel-badge">{freshnessHebrew(data.source.freshness_state)}</span></div><div className="table-wrap"><table className="table"><thead><tr><th>אסטרטגיה</th><th>מצב</th><th>סטטוס</th><th>עסקאות</th><th>P&L</th><th>Expectancy</th><th>אות אחרון</th></tr></thead><tbody>{data.strategies.map(s => <tr key={s.id}><td><strong>{s.name}</strong><div className="row-sub mono">{s.key}</div></td><td>{modeHebrew(s.mode)}</td><td>{s.status}</td><td>{s.trade_count ?? "—"}</td><td className={pnlClass(s.pnl_usd)}>{money(s.pnl_usd)}</td><td>{money(s.expectancy_usd)}</td><td>{s.latest_signal ?? "לא זמין"}</td></tr>)}</tbody></table></div></section>;
}

function BybitView({ data }: { data?: BybitBotsOutput }) {
  if (!data) return <Empty title="נתוני Bybit Bots עדיין לא נטענו" />;
  return <><div className="kpis"><Kpi label="שווי חשבון Bot" value={money(data.total_bot_account_equity_usd)} sub="מקור Bybit Read-Only" /><Kpi label="פירוט בוטים" value={data.details_available ? String(data.bots.length) : "לא זמין"} sub={data.details_status} /><Kpi label="הרשאת מסחר דרך הוידגט" value="חסומה" sub="אין כלי write ב-V1" /><Kpi label="מצב מקור" value={freshnessHebrew(data.source.freshness_state)} sub={ageLabel(data.source.age_seconds)} /></div><section className="card panel">{data.details_available && data.bots.length ? <div className="table-wrap"><table className="table"><thead><tr><th>סוג</th><th>סמל</th><th>סטטוס</th><th>השקעה</th><th>שווי</th><th>P&L</th><th>טווח</th></tr></thead><tbody>{data.bots.map(b => <tr key={b.id}><td>{b.kind}</td><td>{b.symbol ?? "—"}</td><td>{b.status}</td><td>{money(b.invested_usd)}</td><td>{money(b.equity_usd)}</td><td className={pnlClass(b.total_pnl_usd)}>{money(b.total_pnl_usd)}</td><td>{b.range_low === null || b.range_high === null ? "לא זמין" : `${b.range_low}–${b.range_high}`}</td></tr>)}</tbody></table></div> : <Empty title="שווי חשבון הבוטים זמין, אבל אין API מאומת לפירוט בוט בודד" subtitle="CryptoBot אינו ממציא Grid/DCA P&L, טווח או מספר גרידים ללא מקור קריאה מאומת." />}</section></>;
}

function PortfolioView({ data }: { data?: PortfolioOutput }) {
  if (!data) return <Empty title="נתוני התיק עדיין לא נטענו" />;
  return <><div className="kpis"><Kpi label="שווי כולל" value={money(data.total_equity_usd)} /><Kpi label="נכסים" value={String(data.assets.length)} /><Kpi label="פוזיציות פתוחות" value={String(data.positions.length)} /><Kpi label="עסקאות אחרונות" value={String(data.recent_trades.length)} /></div><div className="grid2"><section className="card panel"><div className="panel-head"><div className="panel-title">חלוקת חשבונות</div></div><div className="list">{data.account_breakdown.map(x => <div className="row" key={x.account_type}><div className="row-title">{x.account_type}</div><div className="mono">{money(x.usd_value)}</div></div>)}</div></section><section className="card panel"><div className="panel-head"><div className="panel-title">נכסים</div></div><div className="list">{data.assets.slice(0,8).map((a,i) => <div className="row" key={`${a.coin}-${i}`}><div><div className="row-title">{a.coin}</div><div className="row-sub">{a.account_type ?? "חשבון לא ידוע"}</div></div><div><div className="mono">{money(a.usd_value)}</div><div className="row-sub mono">{a.quantity ?? "—"}</div></div></div>)}</div></section></div></>;
}

function RiskView({ data }: { data?: RiskStatus }) {
  if (!data) return <Empty title="נתוני הסיכון עדיין לא נטענו" />;
  return <><div className="kpis"><Kpi label="חשיפה" value={money(data.exposure_usd)} sub={`מקסימום: ${money(data.max_exposure_usd)}`} /><Kpi label="Drawdown" value={percent(data.drawdown_pct)} sub={`מקסימום: ${percent(data.max_drawdown_pct)}`} /><Kpi label="פוזיציות" value={data.open_positions === null ? "לא זמין" : String(data.open_positions)} sub={`מקסימום: ${data.max_open_positions ?? "לא זמין"}`} /><Kpi label="Reconciliation" value={data.reconciliation_state} sub={data.kill_switch ? "Kill Switch פעיל" : "Kill Switch לא פעיל"} /></div><section className="card panel"><div className="panel-head"><div><div className="panel-title">אירועי סיכון אחרונים</div><div className="panel-sub">הגנות ונקודות תשומת לב</div></div></div><div className="list">{data.recent_events.length ? data.recent_events.map(e => <div className="row" key={e.id}><div><div className="row-title">{e.title}</div><div className="row-sub">{e.message}</div></div><StatePill state={e.severity === "critical" ? "bad" : e.severity === "warning" ? "warn" : "good"} label={e.severity} /></div>) : <Empty title="אין אירועי סיכון פעילים" />}</div></section></>;
}

function SystemView({ data }: { data?: SystemHealth }) {
  if (!data) return <Empty title="נתוני המערכת עדיין לא נטענו" />;
  return <><div className="kpis"><Kpi label="מצב כולל" value={systemStateHebrew(data.overall_state)} /><Kpi label="הרשאה" value="Read-Only" sub={data.authorization_mode} /><Kpi label="מסחר מהוידגט" value={data.exchange_trading_enabled ? "מופעל" : "חסום"} /><Kpi label="משיכות" value={data.withdrawals_enabled ? "מופעלות" : "חסומות"} /></div><section className="card panel"><div className="panel-head"><div><div className="panel-title">רכיבי מערכת</div><div className="panel-sub">חיבור, טריות, זרמים ומעטפת הרשאות</div></div></div><div className="list">{data.components.map(c => <div className="row" key={c.key}><div><div className="row-title">{c.label}</div><div className="row-sub">{c.message ?? freshnessHebrew(c.meta.freshness_state)}</div></div><StatePill state={c.state === "ok" ? "good" : c.state === "fault" ? "bad" : "warn"} label={c.state} /></div>)}</div></section></>;
}

function Empty({ title, subtitle }: { title: string; subtitle?: string }) { return <div className="empty"><div><strong>{title}</strong>{subtitle ? <span>{subtitle}</span> : null}</div></div>; }

function App() {
  const persisted = readWidgetState<WidgetState>();
  const [tab, setTab] = useState<Tab>(persisted?.tab ?? "overview");
  const [data, setData] = useState<ControlCenterBootstrap | null>(null);
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState<DecisionExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeToolResults(value => { const parsed = safeBootstrap(value); if (parsed) setData(parsed); }), []);
  useEffect(() => { writeWidgetState({ tab }); }, [tab]);

  const refresh = async () => {
    setLoading(true); setError(null);
    try {
      const next = await callCryptoBotTool("open_control_center");
      const parsed = safeBootstrap(next);
      if (parsed) setData(parsed); else setError("התקבלה תשובה שאינה תואמת למודל התצוגה.");
    } catch (e) { setError(e instanceof Error ? e.message : "refresh_failed"); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (!data) void refresh(); }, []);

  const explain = async (id: string) => {
    try { setExplanation(await callCryptoBotTool("explain_decision", { decision_id: id }) as DecisionExplanation); }
    catch { setExplanation(null); }
  };

  const active = useMemo(() => {
    if (!data) return null;
    if (tab === "overview") return <OverviewView data={data} onExplain={explain} />;
    if (tab === "algobot") return <AlgoView data={data.algobot} />;
    if (tab === "bybit") return <BybitView data={data.bybit_bots} />;
    if (tab === "portfolio") return <PortfolioView data={data.portfolio} />;
    if (tab === "risk") return <RiskView data={data.risk} />;
    return <SystemView data={data.system} />;
  }, [tab, data]);

  return <div className="app"><div className="shell">
    <header className="topbar"><div className="brand"><div className="logo">CB</div><div><h1>מרכז השליטה של CryptoBot</h1><p>AlgoBot · Bybit · Risk · System Health</p></div></div><div className="top-actions"><span className="chip"><span className="dot good" />Read-Only</span><span className="chip hide-mobile">Mainnet</span>{data ? <span className="chip hide-mobile"><span className={`dot ${data.overview.system_state === "healthy" ? "good" : data.overview.system_state === "emergency_stop" ? "bad" : "warn"}`} />{systemStateHebrew(data.overview.system_state)}</span> : null}<button className="iconbtn" onClick={refresh} disabled={loading}>{loading ? "מעדכן…" : "רענון"}</button>{canRequestFullscreen() ? <button className="iconbtn" onClick={() => void requestFullscreen()}>מסך מלא</button> : null}</div></header>
    <div className="tabs" role="tablist" aria-label="מסכי CryptoBot">{(Object.keys(TAB_LABELS) as Tab[]).map(key => <button role="tab" aria-selected={tab === key} key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{TAB_LABELS[key]}</button>)}</div>
    {error ? <div className="notice"><span>חלק מהמידע לא נטען: {error}</span><button className="refreshbtn" onClick={refresh}>נסה שוב</button></div> : null}
    {!data ? <div className="card loading"><div><div className="spinner" aria-label="טוען" /><div className="muted small" style={{marginTop:12}}>טוען נתונים מאומתים…</div></div></div> : active}
    {explanation ? <section className="card panel details" aria-live="polite"><div className="panel-head"><div><div className="panel-title">הסבר החלטה #{explanation.decision_id}</div><div className="panel-sub">{explanation.symbol ?? ""} · {explanation.strategy ?? ""}</div></div><button className="iconbtn" onClick={() => setExplanation(null)}>סגור</button></div><div className="decision-reason">{explanation.explanation_he}</div>{explanation.rejection_reasons.length ? <><h3>סיבות דחייה</h3><ul>{explanation.rejection_reasons.map(x => <li key={x}>{x}</li>)}</ul></> : null}</section> : null}
  </div></div>;
}

const style = document.createElement("style");
style.textContent = styles;
document.head.appendChild(style);
const root = document.getElementById("cryptobot-root");
if (!root) throw new Error("cryptobot_root_missing");
createRoot(root).render(<App />);
