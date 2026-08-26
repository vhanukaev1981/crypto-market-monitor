# CryptoBot ChatGPT Control Center V1 — Design Specification

Date: 2026-08-26
Status: APPROVED FOR SPEC REVIEW
Scope: V1 read-only ChatGPT control center
Repository: `vhanukaev1981/crypto-market-monitor`

## 1. Goal

Build a professional, Hebrew-first, RTL, mobile-first CryptoBot control center that runs inside ChatGPT and becomes the primary user-facing interface for the trading system.

The trading system itself remains independent and runs 24/7 in cloud infrastructure. ChatGPT is the control and observability surface, not the execution dependency.

V1 is strictly read-only. It can display, explain, filter and drill into system state, but it cannot open/close trades, change strategies, change risk, pause/resume trading, or trigger a kill switch.

## 2. Product principles

1. **ChatGPT is the primary control plane** — no separate user-facing mobile app is required.
2. **Everything visible, nothing mixed** — AlgoBot results, Bybit built-in bots and total account state are clearly separated.
3. **Fail-safe by design** — the dashboard never becomes a dependency for execution or position survival.
4. **Read-only V1** — no state-changing MCP tool exists in this version.
5. **Freshness is explicit** — stale data is never presented as live.
6. **Mobile-first, desktop-grade** — optimized for Android/mobile use, while expanding into a professional fullscreen desktop layout.
7. **Hebrew-first RTL** — all user-facing labels, statuses and explanations are in Hebrew. Financial symbols and tickers remain in their standard notation.
8. **Professional financial UI** — dark-mode default, restrained visual system, green/red only for financial meaning and system state.

## 3. Existing repository context

The repository already contains a Trading OS UI and Supabase-backed data access:

- `app/page.tsx` contains the current Trading OS experience and direct Supabase data reads.
- `app/chatgpt-auth.ts` contains ChatGPT/SIWC-related authentication helpers for the existing Sites runtime.
- `package.json` already includes Next.js, React, Supabase and TypeScript.
- Supabase migrations and Bybit snapshot data structures already exist, including the legacy-named `bybit_demo_live_snapshot` compatibility table.

The ChatGPT Control Center will reuse existing domain data but will not reuse the existing page architecture directly. It will introduce a stable data gateway and an isolated ChatGPT-specific UI surface.

## 4. Chosen architecture

Chosen approach: **same repository, isolated ChatGPT subsystem**.

We explicitly reject:

- wrapping the current Trading OS page directly inside ChatGPT;
- starting a separate repository for the dashboard;
- allowing the widget to query Bybit directly.

Target flow:

`Bybit / AlgoBot -> Supabase -> CryptoBot Data Gateway -> MCP read tools -> ChatGPT widget`

The 24/7 trading path remains independent:

`Market Data -> Strategy -> Risk Engine -> Order Manager -> Execution -> Bybit`

ChatGPT must never sit in that critical execution path.

## 5. Logical components

### 5.1 CryptoBot Data Gateway

Purpose: provide one stable read model to ChatGPT regardless of internal database/table changes.

Responsibilities:

- query current Supabase state;
- normalize legacy names and inconsistent schemas;
- separate AlgoBot, Bybit bots and account-wide metrics;
- compute freshness and health status;
- redact secrets and private infrastructure details;
- expose strongly typed domain DTOs to MCP tools.

The UI must not know internal table names.

### 5.2 MCP server surface

Target endpoint: stable streamable HTTP MCP endpoint, normally `/mcp`.

V1 tools:

- `get_dashboard_overview`
- `get_algobot_status`
- `get_bybit_bots`
- `get_portfolio`
- `get_risk_status`
- `get_system_health`
- `explain_decision`

All V1 tools must declare:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`

Every tool must enforce authorization server-side. Tool metadata is not an authorization boundary.

### 5.3 ChatGPT Widget UI

Primary archetype: **React widget with decoupled data/render architecture**.

The widget must:

- support fullscreen as the primary rich presentation;
- coexist with the ChatGPT composer, which remains available in fullscreen;
- maintain selected tab/filter state while the conversation continues;
- consume structured tool results rather than query Supabase directly;
- treat incoming structured content as untrusted input;
- avoid unnecessary iframe/widget re-rendering by separating data tools from render tools.

## 6. Main information architecture

The current Trading OS has many separate sections. The ChatGPT Control Center will compress them into five top-level areas.

### 6.1 ראשי

The main screen used most of the time.

Shows:

- total portfolio equity;
- daily / weekly / monthly P&L;
- current drawdown;
- deployed capital;
- number of open positions;
- AlgoBot summary;
- Bybit bot summary;
- latest algorithm decision;
- latest meaningful activity;
- alerts requiring attention;
- overall system state.

### 6.2 AlgoBot

Subsections:

- אסטרטגיות
- אותות
- החלטות
- ביצועים

Per strategy:

- mode: Paper / Shadow / Demo / Live;
- status;
- win rate;
- expectancy;
- P&L;
- drawdown;
- trade count;
- latest signal;
- latest decision;
- rejection/entry explanation.

### 6.3 בוטים של Bybit

Strictly separated from AlgoBot.

Displays:

- DCA state;
- Spot Grid state;
- invested amount;
- bot equity;
- total P&L;
- grid profit;
- configured range;
- grid count;
- recent bot activity.

No Bybit-bot P&L is ever attributed to AlgoBot.

### 6.4 תיק ועסקאות

Subsections:

- חשבון
- נכסים
- פוזיציות
- עסקאות

Displays:

- Funding / Unified / Bot account breakdown;
- BTC / ETH / USDT and other holdings;
- entry/current price;
- quantity/notional;
- stop / target when relevant;
- realized/unrealized P&L;
- trade history.

### 6.5 סיכון ומערכת

Subsections:

- סיכון
- בריאות
- אבטחה
- Audit

Displays:

- daily loss limit usage;
- max drawdown usage;
- exposure;
- kill switch state;
- duplicate prevention;
- reconciliation status;
- Bybit connectivity;
- Supabase health;
- AlgoBot engine health;
- stale-data state;
- errors and warnings;
- audit trail.

## 7. Navigation and layout

### Mobile

- compact sticky top status bar;
- horizontal primary navigation below it;
- no bottom navigation because the ChatGPT composer occupies the lower interaction zone;
- touch targets >= 44px;
- no page-level horizontal scrolling;
- dense tables must reflow into cards or use local horizontal scrolling only where required.

### Desktop / tablet

- compact RTL side navigation;
- multi-column Command Center layout;
- fullscreen preferred for detailed monitoring.

### Persistent status bar

Always visible inside the widget:

`CryptoBot | מצב מערכת | מצב הרשאה | זמן סנכרון אחרון`

System state vocabulary:

- תקין
- מוגבל
- הגנה
- עצירת חירום

## 8. Visual design system

Default presentation: dark financial theme.

Rules:

- neutral dark surfaces;
- restrained borders and spacing;
- green = profit / healthy only;
- red = loss / fault only;
- amber = warning / stale / attention;
- no decorative gradients or neon crypto styling;
- typography prioritizes numeric legibility;
- numbers use LTR direction inside RTL containers;
- Hebrew labels remain concise and professional.

The UI should look closer to a professional institutional trading monitor than to a retail crypto landing page.

## 9. Data freshness model

Every top-level data source exposes:

- `observed_at`
- `age_seconds`
- `freshness_state`
- `source_state`

Freshness is source-specific. Current Bybit account snapshot cadence is slower than internal engine heartbeats, so thresholds must not be identical.

Initial policy:

- AlgoBot heartbeat: target seconds-level freshness when available;
- Risk Engine heartbeat: target seconds-level freshness when available;
- execution/reconciliation heartbeat: seconds to tens of seconds depending on component;
- Bybit account snapshot: based on actual configured snapshot cadence, currently minute-oriented;
- any source beyond its expected window becomes `stale` and is visually marked.

The UI must never silently retain an old value while labelling it live.

## 10. 24/7 resilience model

### 10.1 ChatGPT unavailable

No effect on trading. Only observability/control UI is unavailable.

### 10.2 Supabase temporarily unavailable

The execution engine must not depend on a live UI request path. Critical runtime state is persisted/recoverable by the engine. Events should be queued or reconciled after recovery where supported.

### 10.3 Bybit read API unavailable

No new trade should be opened if current account/position state cannot be reconciled with sufficient confidence.

### 10.4 Market data stale

No new trading signal may progress to execution.

### 10.5 Risk Engine unavailable

Fail closed: no new trade.

### 10.6 Reconciliation mismatch

Pause new entries until state is reconciled.

### 10.7 Restart recovery

On AlgoBot restart:

1. restore durable state;
2. query/reconcile exchange state;
3. detect orphan/duplicate/inconsistent orders or positions;
4. verify risk controls;
5. resume new entries only after recovery gates pass.

### 10.8 Financial retries

No infinite retries.

Future execution actions must use:

- idempotency/client order identifiers;
- bounded retry policy;
- timeout;
- explicit terminal status;
- audit event;
- reconciliation before repeated execution after ambiguous failures.

## 11. Security and authorization

### 11.1 V1 boundary

V1 contains no write-capable trading tool.

There is no MCP route that can:

- create/cancel an order;
- close a position;
- modify risk;
- pause/resume strategy execution;
- change live mode;
- trigger a kill switch.

This is enforced structurally, not only by UI hiding.

### 11.2 Authentication

The MCP server must authenticate private requests and map the authenticated ChatGPT user to an allowed CryptoBot identity.

For development:

- use ChatGPT developer mode and a secure/private MCP connection;
- restrict access to the single authorized user identity.

For production/internal use:

- use OpenAI-supported MCP authentication/OAuth flow;
- maintain explicit server-side user authorization mapping;
- deny by default.

The existing `app/chatgpt-auth.ts` may be reusable for the Sites surface but must not be assumed to satisfy MCP authorization until verified against the current plugin authentication contract.

### 11.3 Bybit credential boundary

Personal-account reads are restricted to the existing read-only Bybit credential pair:

- `BYBIT_LIVE_API_KEY`
- `BYBIT_LIVE_API_SECRET`

The ChatGPT Control Center must not use `BYBIT_LIVE_TRADE_*`, `BYBIT_DEMO_*`, or any alternative Bybit credential for personal-account reads.

Where possible, V1 consumes the already-normalized Supabase snapshot rather than calling Bybit directly. If a server-side refresh of the personal account is required, it must go through the approved read-only snapshot path and preserve the global read-only validation.

V1 never introduces, requests or consumes a write-capable personal Bybit key.

### 11.4 Secrets

Never expose:

- Bybit API keys;
- Supabase service-role keys;
- cron tokens;
- internal signing secrets;
- unrestricted database credentials.

Secrets remain server-side.

The ChatGPT widget receives only normalized data required for display.

### 11.5 Supabase access

The Data Gateway owns database access.

If a privileged server credential is used, all queries must be explicitly scoped to the authorized CryptoBot user because privileged credentials may bypass RLS.

No service-role credential may reach client-side code.

### 11.6 Tool output privacy

`structuredContent`, text content and `_meta` must contain no secret or unnecessary sensitive infrastructure data.

`_meta` is not considered a secure vault; authorization must be enforced before data is returned.

## 12. Error handling UX

The UI uses explicit states rather than generic errors.

Examples:

- `מידע עדכני`
- `מתעדכן`
- `מידע מיושן`
- `מקור לא זמין`
- `אין מספיק נתונים`
- `גישה נדחתה`

A source failure must not blank unrelated sections.

Each panel should degrade independently where possible.

The main system banner reflects the highest-severity meaningful state.

## 13. Explainability

`explain_decision` returns a concise human-readable explanation for a specific AlgoBot decision.

Required fields:

- decision id;
- strategy;
- symbol;
- direction/candidate action;
- signal evidence;
- risk checks;
- liquidity/spread/volatility checks when available;
- final decision;
- rejection reason or execution rationale;
- timestamp and freshness.

The explanation must describe recorded facts. It must not invent a rationale that was not persisted by the strategy/risk system.

## 14. Read-only MCP tool contracts

### `get_dashboard_overview`

Returns compact top-level metrics and alert/system summaries.

### `get_algobot_status`

Returns strategy, signal, decision and execution summaries with drill-down identifiers.

### `get_bybit_bots`

Returns Bybit DCA/Grid data only.

### `get_portfolio`

Returns account breakdown, holdings, open positions and recent trades.

### `get_risk_status`

Returns current risk limits, usage, kill-switch state, protection and reconciliation state.

### `get_system_health`

Returns component health, heartbeat/freshness and error summaries.

### `explain_decision`

Input: stable decision identifier.

Output: fact-grounded explanation object suitable for both ChatGPT narration and the widget.

## 15. Decoupled rendering pattern

Data calls do not automatically replace/recreate the widget.

Preferred flow:

1. render/open Control Center;
2. widget receives current structured state;
3. subsequent data tools refresh the relevant state model;
4. widget updates in place;
5. conversation continues through ChatGPT composer.

This follows OpenAI's recommendation to separate data processing from UI rendering to avoid unnecessary widget re-rendering.

## 16. Testing strategy

### 16.1 Data Gateway

- unit tests for normalization and calculations;
- stale/fresh threshold tests;
- missing/null data tests;
- legacy schema compatibility tests;
- user scoping tests.

### 16.2 MCP tools

- schema validation;
- `readOnlyHint` verification;
- direct successful calls;
- invalid-input calls;
- unauthorized-user negative tests;
- no-secret output scan;
- deterministic error shape tests.

### 16.3 UI

- RTL layout tests;
- 320/360/390px mobile widths;
- tablet/desktop fullscreen widths;
- dark-mode visual inspection;
- stale/error/partial-source states;
- large-number and long-symbol layout;
- keyboard/focus/accessibility checks;
- tab state persistence during refresh.

### 16.4 Integration

- MCP Inspector initialization and tool calls;
- ChatGPT developer-mode connection;
- open fullscreen and keep composer usable;
- refresh without full widget reset;
- confirm no Bybit write request is emitted;
- verify authorization is enforced on every private tool call.

## 17. Acceptance criteria for V1

V1 is accepted only when all are true:

1. ChatGPT can open the CryptoBot Control Center inside the conversation.
2. Fullscreen works and the ChatGPT composer remains available.
3. UI is Hebrew-first and RTL.
4. The five primary navigation areas are implemented.
5. AlgoBot and Bybit bots are visually and numerically separated.
6. Portfolio/account data is grounded in current Supabase state.
7. Every major metric exposes freshness.
8. Stale/unavailable data is clearly labelled.
9. All MCP tools are read-only and server-authorized.
10. No secret is present in widget/tool output.
11. No Bybit write request can be produced by V1.
12. Widget state survives routine data refreshes without unnecessary full re-render.
13. Mobile layout is usable without requiring a separate external app.
14. Dashboard availability is not required for AlgoBot 24/7 operation.
15. Personal-account Bybit reads use only the approved read-only credential pair and never any trade/demo credential set.

## 18. Non-goals for V1

Not included:

- open/close trade buttons;
- pause/resume strategy;
- change risk limits;
- live capital promotion;
- kill-switch activation from ChatGPT;
- deposits/withdrawals;
- public app-directory publication;
- replacing the independent AlgoBot execution engine.

These require a separate write-control specification with confirmation, authorization, audit and safety gates.

## 19. Planned implementation boundary

Recommended internal structure, subject to implementation-plan validation:

- `lib/cryptobot/` — domain DTOs, Data Gateway, normalization, health/freshness logic;
- `app/mcp/route.ts` — thin MCP transport endpoint or equivalent stable `/mcp` adapter;
- `chatgpt-control-center/` — isolated widget bundle/components/localization;
- `tests/cryptobot-control-center/` — contracts, authorization, freshness and integration tests.

Existing `app/page.tsx` remains operational and is not used as the ChatGPT widget implementation.

## 20. Rollout sequence

1. Data Gateway and typed read model.
2. Read-only MCP server and authentication boundary.
3. Hebrew RTL widget shell and five-area navigation.
4. Overview + system/freshness states.
5. AlgoBot detail views.
6. Bybit bots and portfolio views.
7. Risk/system/audit views.
8. Explain-decision flow.
9. MCP Inspector and ChatGPT developer-mode E2E.
10. Internal V1 acceptance.

Only after V1 is stable should a separate V2 design consider state-changing controls.

## 21. OpenAI implementation references

Current OpenAI documentation used for this design:

- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/reference

Key design choices grounded in those docs:

- use a stable streamable HTTP MCP endpoint;
- explicitly annotate read-only tools;
- enforce authorization server-side;
- keep secrets out of tool results;
- use fullscreen for rich tasks while preserving the ChatGPT composer;
- separate data processing from UI rendering to reduce unnecessary widget re-rendering.
