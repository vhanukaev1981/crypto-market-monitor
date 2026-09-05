"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { createClient, type User } from "@supabase/supabase-js";

const supabase = createClient(
  "https://xabffbjifmnoogzcttyd.supabase.co",
  "sb_publishable_-0xlsgjpG-xwVfaUGTag4A_wvgxVWwD",
);

const shellCss = `
:root{color-scheme:dark}
.platform-frame{min-height:100vh;direction:rtl;background:#050b16;color:#eef8ff;display:grid;grid-template-columns:248px minmax(0,1fr);font-family:inherit}
.platform-sidebar{position:sticky;top:0;height:100vh;border-left:1px solid #15334a;background:linear-gradient(180deg,#071625 0%,#06111e 65%,#050d17 100%);padding:18px 14px;display:flex;flex-direction:column;z-index:40;box-shadow:0 0 50px rgba(0,0,0,.22)}
.platform-brand{display:flex;align-items:center;gap:11px;padding:5px 6px 20px;border-bottom:1px solid rgba(43,82,108,.45)}
.platform-brand-mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#21c9ee,#46ecb4);color:#04121b;font-weight:950;font-size:19px;box-shadow:0 8px 24px rgba(33,201,238,.2)}
.platform-brand strong{display:block;font-size:13px;letter-spacing:.05em}.platform-brand small{display:block;color:#6f8da4;font-size:10px;margin-top:3px;letter-spacing:.12em}
.platform-section-label{font-size:10px;color:#607c91;font-weight:900;letter-spacing:.14em;padding:19px 10px 8px}
.platform-nav{display:grid;gap:5px}.platform-nav a,.platform-nav button{width:100%;display:flex;align-items:center;gap:11px;text-align:right;border:1px solid transparent;background:transparent;color:#8ea7bb;border-radius:11px;padding:11px 12px;font:inherit;font-size:13px;font-weight:800;text-decoration:none;cursor:pointer}.platform-nav a:hover{background:#0a1d2d;color:#e8f7ff;border-color:#153a53}.platform-nav a.active{background:linear-gradient(90deg,rgba(49,214,243,.18),rgba(49,214,243,.07));color:#dffaff;border-color:rgba(49,214,243,.27)}.platform-nav button:disabled{cursor:not-allowed;opacity:.5}.platform-nav-icon{width:22px;text-align:center;font-size:15px}.platform-soon{margin-right:auto;font-size:9px;border:1px solid #29465a;border-radius:999px;padding:3px 6px;color:#6e8aa0}
.platform-sidebar-status{margin-top:auto;display:grid;gap:9px}.platform-env-card,.platform-security-card{border:1px solid #17384f;background:#081927;border-radius:13px;padding:12px}.platform-env-row{display:flex;justify-content:space-between;gap:10px;align-items:center}.platform-env-row strong{font-size:12px}.platform-env-row span{font-size:10px;border-radius:999px;padding:4px 8px;font-weight:900}.platform-env-demo{color:#51efb6;border:1px solid rgba(81,239,182,.28);background:rgba(81,239,182,.07)}.platform-env-live{color:#ff8a9b;border:1px solid rgba(255,138,155,.25);background:rgba(255,138,155,.07)}.platform-security-card{color:#708ca1;font-size:10px;line-height:1.55}.platform-security-card strong{display:block;color:#a9c4d6;font-size:11px;margin-bottom:3px}
.platform-main{min-width:0;min-height:100vh;background:radial-gradient(circle at 10% 0%,rgba(35,201,244,.08),transparent 30rem),radial-gradient(circle at 88% 5%,rgba(68,235,179,.055),transparent 27rem),#050b16}
.platform-topbar{position:sticky;top:0;z-index:30;min-height:74px;border-bottom:1px solid rgba(30,65,88,.72);background:rgba(5,14,24,.88);backdrop-filter:blur(18px);display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 22px}
.platform-title-wrap{display:flex;align-items:center;gap:12px;min-width:0}.platform-menu{display:none;width:38px;height:38px;border:1px solid #20445b;background:#091a28;color:#e5f7ff;border-radius:10px;font-size:18px;cursor:pointer}.platform-kicker{display:block;color:#36d7f4;font-size:9px;font-weight:950;letter-spacing:.14em;margin-bottom:3px}.platform-title{margin:0;font-size:20px;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.platform-top-actions{display:flex;align-items:center;gap:9px;min-width:0}.platform-mode{display:flex;align-items:center;gap:6px;border:1px solid #19384e;background:#071724;border-radius:10px;padding:6px}.platform-mode b,.platform-mode span{font-size:10px;padding:5px 8px;border-radius:7px}.platform-mode b{background:rgba(77,235,180,.12);color:#63edbd}.platform-mode span{color:#718da2}.platform-readonly{border:1px solid rgba(53,216,244,.24);color:#61dcf2;background:rgba(53,216,244,.07);border-radius:999px;padding:7px 10px;font-size:10px;font-weight:900;white-space:nowrap}.platform-user{display:flex;align-items:center;gap:9px;border:1px solid #1b3b50;background:#081825;color:#dceefa;border-radius:11px;padding:7px 9px 7px 11px;font:inherit;cursor:pointer;max-width:260px}.platform-avatar{width:31px;height:31px;border-radius:9px;background:#12334a;display:grid;place-items:center;color:#58dbf2;font-weight:950}.platform-user-copy{min-width:0;text-align:right}.platform-user-copy strong{display:block;font-size:11px}.platform-user-copy small{display:block;color:#7894a9;font-size:9px;direction:ltr;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.platform-signout{font-size:9px;color:#ff9eac;margin-right:5px}
.platform-content{min-width:0}.platform-frame .pv2{min-height:auto!important;background:transparent!important;padding:18px 22px 28px!important}.platform-frame .pv2-shell{max-width:none!important;margin:0!important}.platform-frame .pv2-head,.platform-frame .status{display:none!important}.platform-frame .tabs{padding-top:2px!important}.platform-frame .auth{margin-top:8vh!important}
.platform-overlay{display:none}
@media(max-width:980px){.platform-frame{grid-template-columns:1fr}.platform-sidebar{position:fixed;right:0;top:0;width:260px;transform:translateX(105%);transition:transform .2s ease;border-left:1px solid #15334a}.platform-frame.nav-open .platform-sidebar{transform:translateX(0)}.platform-menu{display:grid;place-items:center}.platform-overlay{display:block;position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(2px);border:0;z-index:35;opacity:0;pointer-events:none;transition:opacity .2s}.platform-frame.nav-open .platform-overlay{opacity:1;pointer-events:auto}.platform-topbar{padding:10px 14px}.platform-frame .pv2{padding:14px!important}}
@media(max-width:640px){.platform-mode,.platform-readonly{display:none}.platform-user{max-width:145px}.platform-user-copy strong{display:none}.platform-title{font-size:17px}.platform-topbar{min-height:64px}.platform-frame .pv2{padding:10px!important}}
`;

const navItems = [
  { href: "/platform", label: "מרכז שליטה", icon: "⌂" },
  { href: "/platform/runtime", label: "Runtime חי", icon: "⌁" },
  { href: "/", label: "Trading OS", icon: "◉" },
];

const plannedItems = [
  { label: "מחקר ואסטרטגיות", icon: "◇" },
  { label: "Audit ופעילות", icon: "≡" },
  { label: "הגדרות ואבטחה", icon: "⚙" },
];

export default function PlatformLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (active) {
        setUser(data.user);
        setAuthReady(true);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthReady(true);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => setMobileOpen(false), [pathname]);

  if (!authReady || !user) return <>{children}</>;

  const initial = user.email?.trim().charAt(0).toUpperCase() || "U";

  return (
    <div className={`platform-frame ${mobileOpen ? "nav-open" : ""}`} dir="rtl">
      <style>{shellCss}</style>
      <button
        type="button"
        className="platform-overlay"
        aria-label="סגירת תפריט"
        onClick={() => setMobileOpen(false)}
      />

      <aside className="platform-sidebar" aria-label="ניווט הפלטפורמה">
        <div className="platform-brand">
          <div className="platform-brand-mark">C</div>
          <div>
            <strong>CRYPTO MARKET</strong>
            <small>PLATFORM CONTROL</small>
          </div>
        </div>

        <div className="platform-section-label">מרכז העבודה</div>
        <nav className="platform-nav">
          {navItems.map((item) => {
            const active = item.href === "/platform" ? pathname === "/platform" : pathname === item.href;
            return (
              <a key={item.href} href={item.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
                <span className="platform-nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="platform-section-label">מודולים מתוכננים</div>
        <nav className="platform-nav">
          {plannedItems.map((item) => (
            <button key={item.label} type="button" disabled>
              <span className="platform-nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              <span className="platform-soon">בקרוב</span>
            </button>
          ))}
        </nav>

        <div className="platform-sidebar-status">
          <div className="platform-env-card">
            <div className="platform-env-row">
              <strong>סביבת מסחר</strong>
              <span className="platform-env-demo">DEMO</span>
            </div>
            <div className="platform-env-row" style={{ marginTop: 8 }}>
              <strong>כסף אמיתי</strong>
              <span className="platform-env-live">LIVE נעול</span>
            </div>
          </div>
          <div className="platform-security-card">
            <strong>Control Plane לקריאה בלבד</strong>
            המעטפת אינה שולחת פקודות מסחר ואינה משנה את מנועי ה־Demo.
          </div>
        </div>
      </aside>

      <section className="platform-main">
        <header className="platform-topbar">
          <div className="platform-title-wrap">
            <button
              type="button"
              className="platform-menu"
              aria-label="פתיחת תפריט"
              onClick={() => setMobileOpen(true)}
            >
              ☰
            </button>
            <div>
              <span className="platform-kicker">MULTI-EXCHANGE CONTROL PLANE</span>
              <h1 className="platform-title">מרכז השליטה של Crypto Market</h1>
            </div>
          </div>

          <div className="platform-top-actions">
            <span className="platform-readonly">קריאה בלבד</span>
            <div className="platform-mode" aria-label="מצב סביבה">
              <b>DEMO</b>
              <span>LIVE 🔒</span>
            </div>
            <button
              type="button"
              className="platform-user"
              title="התנתקות"
              onClick={() => void supabase.auth.signOut()}
            >
              <span className="platform-avatar">{initial}</span>
              <span className="platform-user-copy">
                <strong>משתמש מאומת</strong>
                <small>{user.email}</small>
              </span>
              <span className="platform-signout">יציאה</span>
            </button>
          </div>
        </header>

        <div className="platform-content">{children}</div>
      </section>
    </div>
  );
}
