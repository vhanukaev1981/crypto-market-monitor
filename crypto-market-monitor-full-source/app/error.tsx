"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard render failure", error);
  }, [error]);

  const recover = () => {
    try {
      localStorage.removeItem("market-monitor-prefs");
      localStorage.removeItem("market-favorites");
      localStorage.removeItem("market-last-visit");
      localStorage.removeItem("market-last-good");
    } finally {
      window.location.reload();
    }
  };

  return (
    <main className="login-shell" dir="rtl">
      <section className="login-panel" style={{ position: "relative", zIndex: 1, width: "min(520px, 100%)" }}>
        <div className="login-panel-head">
          <span className="login-lock">↻</span>
          <h2>התצוגה זקוקה לרענון</h2>
          <p>זוהתה הגדרה ישנה או נתון לא תקין בדפדפן. החשבון והגדרות הכניסה לא יימחקו.</p>
        </div>
        <button className="login-submit" onClick={recover}>תיקון ורענון התצוגה</button>
      </section>
    </main>
  );
}
