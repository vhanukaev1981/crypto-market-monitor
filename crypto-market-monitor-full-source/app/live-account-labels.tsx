"use client";

import { useEffect } from "react";

const replacements: Array<[string, string]> = [
  ["● סביבת Demo מאובטחת", "● נתוני Mainnet מחוברים"],
  ["המערכת פעילה בסביבת Demo בלבד", "חשבון Mainnet מחובר; ביצוע המסחר נשאר נעול"],
  ["מקור אמת: Bybit Demo", "מקור אמת: Bybit Mainnet"],
  ["פירוט חשבון Bybit Demo", "פירוט חשבון Bybit Mainnet"],
  ["שגיאה בחיבור ל־Bybit Demo", "שגיאה בחיבור ל־Bybit Mainnet"],
  ["ממתין לנתוני Bybit Demo", "ממתין לנתוני Bybit Mainnet"],
  ["Bybit Demo מחובר", "Bybit Mainnet מחובר"],
  ["מצב חיבור Bybit Demo", "מצב חיבור Bybit Mainnet"],
  ["חשבון Demo · קריאה בלבד", "חשבון Live · קריאה בלבד"],
  ["נכסי חשבון Bybit Demo", "נכסי חשבון Bybit Mainnet"],
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

function applyModeLabels() {
  const sideFooter = document.querySelector(".side-footer");
  const footerStrong = sideFooter?.querySelector("strong");
  const footerSmall = sideFooter?.querySelector("small");
  if (footerStrong) footerStrong.textContent = "LIVE DATA מחובר";
  if (footerSmall) footerSmall.textContent = "ביצוע Demo · נעול";

  const modeSwitch = document.querySelector(".mode-switch");
  const modePrimary = modeSwitch?.querySelector("b");
  const modeSecondary = modeSwitch?.querySelector("span");
  if (modePrimary) modePrimary.textContent = "LIVE DATA";
  if (modeSecondary) modeSecondary.textContent = "EXECUTION 🔒";

  const appFooter = document.querySelector(".workspace > footer span");
  if (appFooter) appFooter.textContent = "נתוני Mainnet · ביצוע נעול";
}

function applyLabels() {
  rewriteText(document.body);
  applyModeLabels();
}

export default function LiveAccountLabels() {
  useEffect(() => {
    applyLabels();
    const observer = new MutationObserver(() => applyLabels());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
