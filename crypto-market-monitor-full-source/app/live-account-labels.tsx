"use client";

import { useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://xabffbjifmnoogzcttyd.supabase.co",
  "sb_publishable_-0xlsgjpG-xwVfaUGTag4A_wvgxVWwD",
);

type LiveBot = {
  name?: string | null;
  status?: string | null;
  enabled?: boolean | null;
  kill_switch?: boolean | null;
  last_run_at?: string | null;
  category?: string | null;
};

const replacements: Array<[string, string]> = [
  ["● סביבת Demo מאובטחת", "● סביבת Mainnet מחוברת"],
  ["המערכת פעילה בסביבת Demo בלבד", "חשבון Mainnet מחובר; ביצוע המסחר נשאר נעול"],
  ["מקור אמת: Bybit Demo", "מקור אמת: Bybit Mainnet"],
  ["פירוט חשבון Bybit Demo", "פירוט חשבון Bybit Mainnet"],
  ["שגיאה בחיבור ל־Bybit Demo", "שגיאה בחיבור ל־Bybit Mainnet"],
  ["ממתין לנתוני Bybit Demo", "ממתין לנתוני Bybit Mainnet"],
  ["Bybit Demo מחובר", "Bybit Mainnet מחובר"],
  ["מצב חיבור Bybit Demo", "מצב חיבור Bybit Mainnet"],
  ["חשבון Demo · קריאה בלבד", "חשבון Live · Mainnet"],
  ["נכסי חשבון Bybit Demo", "נכסי חשבון Bybit Mainnet"],
  ["מנועי המסחר Demo", "מנוע המסחר Live"],
  ["מנוע ספוט Demo", "מנוע ספוט Live"],
  ["מנוע פיוצ׳רס Demo", "מנוע פיוצ׳רס Live"],
  ["אסטרטגיות Demo ו־Shadow", "אסטרטגיות מאושרות ומחקר"],
  ["אסטרטגיות פעילות ב־Demo", "אסטרטגיות מאושרות ל־Live"],
  ["אין עדיין נתוני Demo לאסטרטגיות", "אין עדיין אסטרטגיות מאושרות ל־Live"],
  ["Demo פעילה", "Live מאושרת"],
  ["תקופת Demo יציבה", "תקופת בדיקה יציבה"],
  ["סביבת Demo · תצוגה בלבד", "Mainnet · נתוני אמת"],
  ["DEMO פעיל", "LIVE מחובר"],
  ["Demo", "Live"],
  ["DEMO", "LIVE"],
];

function rewriteText(root: ParentNode) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
      let value = node.nodeValue ?? "";
      for (const [from, to] of replacements) value = value.replaceAll(from, to);
      if (value !== node.nodeValue) node.nodeValue = value;
    }
    node = walker.nextNode();
  }
}

function setText(element: Element | null | undefined, value: string) {
  if (element && element.textContent !== value) element.textContent = value;
}

function formatRun(value?: string | null) {
  if (!value) return "טרם הופעל";
  return new Date(value).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
}

function statusValue(bot: LiveBot | null) {
  if (!bot) return "ממתין לחיבור";
  if (bot.enabled && !bot.kill_switch && bot.status === "running") return "פעיל";
  return "נעול";
}

function appendMetric(parent: HTMLElement, label: string, value: string) {
  const block = document.createElement("div");
  const title = document.createElement("span");
  const result = document.createElement("strong");
  title.textContent = label;
  result.textContent = value;
  block.append(title, result);
  parent.append(block);
}

function renderLiveEngine(container: Element | null, bot: LiveBot | null) {
  if (!(container instanceof HTMLElement)) return;
  const signature = JSON.stringify(bot ?? {});
  if (container.dataset.liveSignature === signature) return;
  container.dataset.liveSignature = signature;
  container.replaceChildren();

  const card = document.createElement("article");
  card.className = "engine-card";
  const head = document.createElement("div");
  head.className = "engine-title";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  const health = document.createElement("small");
  title.textContent = "מנוע ספוט Live";
  health.textContent = statusValue(bot) === "פעיל" ? "מסחר אמיתי פעיל" : "Mainnet מחובר · ביצוע נעול";
  health.className = statusValue(bot) === "פעיל" ? "pass-text" : "unknown-text";
  titleWrap.append(title, health);
  head.append(titleWrap);

  const values = document.createElement("div");
  values.className = "engine-summary-values";
  appendMetric(values, "סטטוס", statusValue(bot));
  appendMetric(values, "Enabled", bot?.enabled ? "כן" : "לא");
  appendMetric(values, "Kill Switch", bot?.kill_switch ? "פעיל" : "כבוי");
  appendMetric(values, "ריצה אחרונה", formatRun(bot?.last_run_at));
  card.append(head, values);
  container.append(card);
}

function applyModeLabels(bot: LiveBot | null) {
  const sideFooter = document.querySelector(".side-footer");
  setText(sideFooter?.querySelector("strong"), "LIVE מחובר");
  setText(sideFooter?.querySelector("small"), statusValue(bot) === "פעיל" ? "מסחר אמיתי פעיל" : "Mainnet · ביצוע נעול");

  const modeSwitch = document.querySelector(".mode-switch");
  setText(modeSwitch?.querySelector("b"), "LIVE");
  setText(modeSwitch?.querySelector("span"), statusValue(bot) === "פעיל" ? "TRADING ON" : "נעול 🔒");

  setText(document.querySelector(".workspace > footer span"), "Mainnet · נתוני אמת");
  renderLiveEngine(document.querySelector(".dashboard-engines"), bot);
  renderLiveEngine(document.querySelector(".system-grid"), bot);

  const overall = document.querySelector(".overall-health");
  setText(overall, statusValue(bot) === "פעיל" ? "Live פעיל" : "Live נעול");
}

function applyLabels(bot: LiveBot | null) {
  rewriteText(document.body);
  applyModeLabels(bot);
}

export default function LiveAccountLabels() {
  useEffect(() => {
    let active = true;
    let bot: LiveBot | null = null;
    let scheduled = false;

    const apply = () => {
      scheduled = false;
      if (active) applyLabels(bot);
    };
    const scheduleApply = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(apply);
    };

    void supabase
      .from("trading_bot_status")
      .select("name,status,enabled,kill_switch,last_run_at,category")
      .eq("category", "spot")
      .maybeSingle()
      .then(({ data }) => {
        bot = (data as LiveBot | null) ?? null;
        scheduleApply();
      });

    scheduleApply();
    const observer = new MutationObserver(scheduleApply);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);

  return null;
}
