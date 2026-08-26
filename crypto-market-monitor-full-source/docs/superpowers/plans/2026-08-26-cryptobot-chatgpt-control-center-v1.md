# CryptoBot ChatGPT Control Center V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade, Hebrew-first, RTL, read-only CryptoBot control center inside ChatGPT, backed by existing Supabase/Bybit/AlgoBot data, with secure MCP tools, fullscreen UI, explicit freshness, and no trading write path.

**Architecture:** Keep the current Trading OS and trading engine untouched. Add an isolated CryptoBot subsystem in the same repository: a server-side Supabase Data Gateway, read-only MCP tools, one render-only control-center tool/resource, and a React widget bundle. ChatGPT remains observability/control UI only and is never in the 24/7 execution path.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.9.x, React 19.2.x, Supabase JS, MCP TypeScript SDK, `@modelcontextprotocol/ext-apps`, Zod, Express, JOSE, esbuild, Node test runner + tsx.

**Spec:** `docs/superpowers/specs/2026-08-26-cryptobot-chatgpt-control-center-v1-design.md`

## Global Constraints

- V1 is strictly read-only: no order create/cancel, close-position, strategy mutation, risk mutation, pause/resume, live-mode mutation, or kill-switch mutation.
- Personal Bybit reads use only `BYBIT_LIVE_API_KEY` and `BYBIT_LIVE_API_SECRET`.
- The personal Bybit key must pass the existing global `readOnly === 1` check before private reads are trusted.
- The widget never receives Bybit credentials, Supabase service-role credentials, cron tokens, signing secrets, or unrestricted database credentials.
- All private MCP tools enforce authorization server-side; annotations are not an authorization boundary.
- Hebrew-first `dir="rtl"`, mobile-first, dark financial theme; green/red are semantic only.
- AlgoBot metrics, Bybit built-in bot metrics, and total account metrics remain separate.
- Every top-level source returns `observed_at`, `age_seconds`, `freshness_state`, `source_state`.
- Stale data is visibly stale and is never silently presented as live.
- ChatGPT availability has zero effect on AlgoBot/Bybit execution continuity.
- Existing `app/page.tsx` remains functional throughout V1 work.
- Current production `bybit-mainnet-live-snapshot` remains `verify_jwt=true`.
- Data tools do not attach UI templates. One render-only tool opens the control center.
- Technical clarification: add `open_control_center` as the single render-only, still read-only MCP tool required by the approved decoupled rendering architecture.

## File Structure

- `package.json` — MCP/widget scripts and dependencies.
- `src/cryptobot/domain.ts` — canonical Zod DTO schemas.
- `src/cryptobot/freshness.ts` — source freshness rules.
- `src/cryptobot/supabase.ts` — server-only scoped Supabase adapter.
- `src/cryptobot/gateway.ts` and `src/cryptobot/gateway/*.ts` — normalized read facade.
- `src/cryptobot/bybit-bot-normalizer.ts` — sanitize Bybit strategy data.
- `mcp/auth.ts` — OAuth bearer verification and principal mapping.
- `mcp/create-server.ts` — creates authorized `McpServer` instances.
- `mcp/server.ts` — HTTP transport, OAuth metadata, health endpoint.
- `mcp/tool-result.ts` — uniform result/error shapes.
- `mcp/widget-resource.ts` — registers `ui://cryptobot/control-center.html`.
- `mcp/tools/*.ts` — one file per MCP tool.
- `mcp/web/index.html` — widget resource shell.
- `mcp/web/src/*.tsx` — React widget and five primary areas.
- `tests/cryptobot/*.test.ts` — unit/security/contract tests.
- `docs/cryptobot/chatgpt-control-center-runbook.md` — operational runbook.

---

### Task 1: Add MCP/widget build and test foundation

**Files:**
- Modify: `package.json`
- Create: `mcp/web/index.html`
- Create: `tests/cryptobot/domain.test.ts`

**Interfaces:**
- Produces scripts: `test:cryptobot`, `mcp:build-widget`, `mcp:build-server`, `mcp:build`, `mcp:dev`, `mcp:start`.

- [ ] **Step 1: Write the first failing domain smoke test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { FreshnessStateSchema } from "../../src/cryptobot/domain.ts";

test("freshness states are explicit", () => {
  assert.deepEqual(FreshnessStateSchema.options, ["fresh", "aging", "stale", "unavailable"]);
});
```

- [ ] **Step 2: Run it and verify module resolution fails**

```bash
node --import tsx --test tests/cryptobot/domain.test.ts
```

- [ ] **Step 3: Install the minimum required packages**

```bash
npm install @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod express cors jose
npm install -D tsx esbuild @types/express @types/cors
```

- [ ] **Step 4: Add scripts**

```json
{
  "test:cryptobot": "node --import tsx --test tests/cryptobot/*.test.ts",
  "mcp:build-widget": "esbuild mcp/web/src/main.tsx --bundle --format=esm --minify --outfile=mcp/dist/widget.js",
  "mcp:build-server": "esbuild mcp/server.ts --bundle --platform=node --format=esm --outfile=mcp/dist/server.js",
  "mcp:build": "npm run mcp:build-widget && npm run mcp:build-server",
  "mcp:dev": "tsx mcp/server.ts",
  "mcp:start": "node mcp/dist/server.js"
}
```

- [ ] **Step 5: Create the widget shell**

```html
<div id="cryptobot-root" dir="rtl"></div>
<script type="module">__CRYPTOBOT_WIDGET_BUNDLE__</script>
```

- [ ] **Step 6: Run existing tests before feature work**

```bash
npm test
```

Expected: current rendered HTML and safety tests pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json mcp/web/index.html tests/cryptobot/domain.test.ts
git commit -m "chore: add CryptoBot MCP build foundation"
```

---

### Task 2: Define canonical DTOs and freshness semantics

**Files:**
- Create: `src/cryptobot/domain.ts`
- Create: `src/cryptobot/freshness.ts`
- Modify: `tests/cryptobot/domain.test.ts`
- Create: `tests/cryptobot/freshness.test.ts`

**Interfaces:**
- Produces `FreshnessState`, `SourceState`, `SourceMetaSchema`, seven data output schemas, one bootstrap schema, and `computeFreshness()`.

- [ ] **Step 1: Add common metadata test**

```ts
const parsed = SourceMetaSchema.parse({
  observed_at: "2026-08-26T12:00:00.000Z",
  age_seconds: 7,
  freshness_state: "fresh",
  source_state: "ok",
});
assert.equal(parsed.age_seconds, 7);
```

- [ ] **Step 2: Add freshness tests**

```ts
const NOW = Date.parse("2026-08-26T12:00:30.000Z");
assert.equal(computeFreshness("2026-08-26T12:00:25.000Z", { freshSeconds: 10, staleSeconds: 30 }, NOW).state, "fresh");
assert.equal(computeFreshness("2026-08-26T11:59:00.000Z", { freshSeconds: 10, staleSeconds: 30 }, NOW).state, "stale");
assert.equal(computeFreshness(null, { freshSeconds: 10, staleSeconds: 30 }, NOW).state, "unavailable");
```

- [ ] **Step 3: Implement common Zod contracts**

```ts
import { z } from "zod";

export const FreshnessStateSchema = z.enum(["fresh", "aging", "stale", "unavailable"]);
export const SourceStateSchema = z.enum(["ok", "attention", "fault", "unknown"]);
export const SourceMetaSchema = z.object({
  observed_at: z.string().datetime().nullable(),
  age_seconds: z.number().nonnegative().nullable(),
  freshness_state: FreshnessStateSchema,
  source_state: SourceStateSchema,
});
```

Numeric fields missing at source stay `null`; they are never invented as zero.

- [ ] **Step 4: Implement freshness rules**

```ts
export function computeFreshness(observedAt: string | null | undefined, policy: { freshSeconds: number; staleSeconds: number }, nowMs = Date.now()) {
  if (!observedAt) return { ageSeconds: null, state: "unavailable" as const };
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return { ageSeconds: null, state: "unavailable" as const };
  const ageSeconds = Math.max(0, Math.floor((nowMs - observedMs) / 1000));
  if (ageSeconds <= policy.freshSeconds) return { ageSeconds, state: "fresh" as const };
  if (ageSeconds <= policy.staleSeconds) return { ageSeconds, state: "aging" as const };
  return { ageSeconds, state: "stale" as const };
}
```

Policies:
- AlgoBot/Risk heartbeat: fresh <=15s, aging <=60s.
- Reconciliation: fresh <=60s, aging <=180s.
- Bybit account snapshot: fresh <=75s, aging <=180s.

- [ ] **Step 5: Run tests and commit**

```bash
npm run test:cryptobot
git add src/cryptobot tests/cryptobot
git commit -m "feat: define CryptoBot read models and freshness"
```

---

### Task 3: Build authorization boundary and scoped Supabase adapter

**Files:**
- Create: `mcp/auth.ts`
- Create: `src/cryptobot/supabase.ts`
- Create: `tests/cryptobot/auth.test.ts`

**Interfaces:**
- `CryptoBotPrincipal = { subject: string; email: string | null; supabaseUserId: string }`
- `verifyBearerToken(token): Promise<CryptoBotPrincipal>`
- `createScopedSupabase(principal)`
- Env names only: `CRYPTOBOT_OAUTH_ISSUER`, `CRYPTOBOT_OAUTH_AUDIENCE`, `CRYPTOBOT_ALLOWED_SUBJECTS`, `CRYPTOBOT_SUPABASE_USER_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 1: Write negative auth tests**

Cover missing token, wrong issuer, wrong audience, expired token, disallowed subject, allowed subject.

- [ ] **Step 2: Implement JOSE verification**

```ts
const { payload } = await jwtVerify(token, jwks, {
  issuer: requiredEnv("CRYPTOBOT_OAUTH_ISSUER"),
  audience: requiredEnv("CRYPTOBOT_OAUTH_AUDIENCE"),
});
const subject = String(payload.sub ?? "");
if (!allowedSubjects().has(subject)) throw new Error("principal_not_allowed");
return {
  subject,
  email: typeof payload.email === "string" ? payload.email : null,
  supabaseUserId: requiredEnv("CRYPTOBOT_SUPABASE_USER_ID"),
};
```

No MCP input accepts `user_id`.

- [ ] **Step 3: Implement server-only Supabase creation**

```ts
export function createScopedSupabase(principal: CryptoBotPrincipal) {
  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, userId: principal.supabaseUserId };
}
```

Every later query must include the scoped `userId` predicate.

- [ ] **Step 4: Add client-bundle leakage test**

Recursively scan `mcp/web/src/` and fail if it contains `SUPABASE_SERVICE_ROLE_KEY`, `BYBIT_LIVE_API_SECRET`, or `createClient(`.

- [ ] **Step 5: Run tests and commit**

```bash
npm run test:cryptobot
git add mcp/auth.ts src/cryptobot/supabase.ts tests/cryptobot/auth.test.ts
git commit -m "feat: enforce CryptoBot MCP authorization boundary"
```

---

### Task 4: Extend the read-only Bybit snapshot with built-in bot visibility

**Files:**
- Create canonical Git copy: `supabase/functions/bybit-mainnet-live-snapshot/index.ts`
- Create: `src/cryptobot/bybit-bot-normalizer.ts`
- Create: `tests/cryptobot/bybit-bots-normalization.test.ts`

**Interfaces:**
- Start from deployed `bybit-mainnet-live-snapshot` version 9 source, not a rewrite.
- Preserve only `BYBIT_LIVE_API_KEY` / `BYBIT_LIVE_API_SECRET`.
- Add only documented read endpoint `GET /v5/strategy/list`.

- [ ] **Step 1: Import exact deployed V9 source to Git**

Preserve `verify_jwt=true`, global read-only assertion, `sends_exchange_orders:false`, and existing snapshot behavior.

- [ ] **Step 2: Write bot normalizer tests**

Normalize to:

```ts
{
  id: string,
  kind: "spot_grid" | "dca" | "other",
  symbol: string | null,
  status: "running" | "paused" | "stopped" | "unknown",
  invested_usd: number | null,
  equity_usd: number | null,
  total_pnl_usd: number | null,
  total_pnl_pct: number | null,
  grid_profit_usd: number | null,
  range_low: number | null,
  range_high: number | null,
  grid_count: number | null,
  observed_at: string
}
```

- [ ] **Step 3: Add `/v5/strategy/list` to the allowed signed GET set**

```ts
"/v5/strategy/list",
```

Call only:

```ts
signedGet("/v5/strategy/list", { category: "spot" })
```

- [ ] **Step 4: Isolate optional bot-detail failure**

If strategy listing is unavailable, the main snapshot still succeeds and records a sanitized `strategy_list_unavailable` state. Do not convert Bot account balance into invented Grid/DCA P&L.

- [ ] **Step 5: Run tests; verify diff contains no write endpoint**

```bash
npm run test:cryptobot
```

Forbidden additions include `/v5/order/create`, `/v5/strategy/create`, `/v5/strategy/stop`, `/v5/dca/create-bot`, `/v5/grid/create-grid`, transfer, or withdrawal mutations.

- [ ] **Step 6: Deploy with `verify_jwt=true`, then verify live snapshot**

Confirm read-only/trading/withdrawal flags remain unchanged and any strategy-list failure is isolated.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/bybit-mainnet-live-snapshot/index.ts src/cryptobot/bybit-bot-normalizer.ts tests/cryptobot/bybit-bots-normalization.test.ts
git commit -m "feat: add read-only Bybit built-in bot visibility"
```

---

### Task 5: Implement server-side CryptoBot Data Gateway

**Files:**
- Create: `src/cryptobot/gateway.ts`
- Create: `src/cryptobot/gateway/overview.ts`
- Create: `src/cryptobot/gateway/algobot.ts`
- Create: `src/cryptobot/gateway/bybit-bots.ts`
- Create: `src/cryptobot/gateway/portfolio.ts`
- Create: `src/cryptobot/gateway/risk.ts`
- Create: `src/cryptobot/gateway/system-health.ts`
- Create: `src/cryptobot/gateway/decision.ts`
- Create: `tests/cryptobot/gateway.test.ts`

**Interfaces:**
- `createCryptoBotGateway(principal)` returns `getDashboardOverview`, `getAlgoBotStatus`, `getBybitBots`, `getPortfolio`, `getRiskStatus`, `getSystemHealth`, `explainDecision`.

- [ ] **Step 1: Write fake-adapter gateway tests**

Verify user scoping, null preservation, source separation, independent panel failure, stale metadata, and fact-only decision explanations.

- [ ] **Step 2: Query existing sources rather than inventing duplicates**

Map the current Trading OS sources:
- `bybit_demo_live_snapshot`
- `trading_dashboard_summary`
- `bybit_demo_account_summary`
- `bybit_demo_account_assets`
- `open_positions_unified`
- `open_positions_summary`
- `trading_bot_status`
- `bot_runs`
- `risk_events`
- current strategy views/tables already used by the repository.

- [ ] **Step 3: Compose compact overview**

```ts
{
  portfolio_equity_usd,
  pnl: { day_usd, week_usd, month_usd },
  drawdown_pct,
  deployed_capital_pct,
  open_positions,
  algobot: { active_strategies, pnl_usd, mode_summary },
  bybit_bots: { count, equity_usd, pnl_usd },
  latest_decision,
  alerts,
  system_state,
  sources
}
```

- [ ] **Step 4: Aggregate system severity**

Priority: `emergency_stop > protection > limited > healthy`. A UI/source outage alone never creates `emergency_stop`.

- [ ] **Step 5: Implement explainability from persisted facts only**

If detailed rationale was not persisted, return `לא נשמר נימוק מפורט` rather than generating one.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:cryptobot
git add src/cryptobot/gateway.ts src/cryptobot/gateway tests/cryptobot/gateway.test.ts
git commit -m "feat: add scoped CryptoBot data gateway"
```

---

### Task 6: Implement read-only MCP tool surface

**Files:**
- Create: `mcp/create-server.ts`
- Create: `mcp/tool-result.ts`
- Create: `mcp/tools/open-control-center.ts`
- Create seven data-tool files
- Create: `tests/cryptobot/mcp-tools.test.ts`

**Interfaces:**
- Tools: `open_control_center`, `get_dashboard_overview`, `get_algobot_status`, `get_bybit_bots`, `get_portfolio`, `get_risk_status`, `get_system_health`, `explain_decision`.
- Every tool: `readOnlyHint:true`, `destructiveHint:false`, `openWorldHint:false`, OAuth scope `cryptobot.read`.

- [ ] **Step 1: Write descriptor tests**

Assert exact names, all read-only annotations, data tools have no UI resource, only `open_control_center` has UI resource, and no mutation-oriented tool exists.

- [ ] **Step 2: Implement server factory**

```ts
export function createCryptoBotMcpServer(principal: CryptoBotPrincipal) {
  const server = new McpServer(
    { name: "cryptobot-control-center", version: "1.0.0" },
    { instructions: "Read-only CryptoBot control center. Never imply these tools can place, cancel, modify, or close trades." },
  );
  const gateway = createCryptoBotGateway(principal);
  registerCryptoBotTools(server, gateway);
  registerCryptoBotWidgetResource(server);
  return server;
}
```

- [ ] **Step 3: Register data tools with explicit output schemas**

Each handler returns schema-valid `structuredContent`, a concise Hebrew `content` summary, no raw DB errors, and no secrets.

- [ ] **Step 4: Implement render-only `open_control_center`**

Attach only this UI metadata:

```ts
_meta: {
  ui: { resourceUri: "ui://cryptobot/control-center.html" },
  "openai/outputTemplate": "ui://cryptobot/control-center.html",
  "openai/toolInvocation/invoking": "פותח את מרכז השליטה…",
  "openai/toolInvocation/invoked": "מרכז השליטה מוכן"
}
```

- [ ] **Step 5: Run tests and commit**

```bash
npm run test:cryptobot
git add mcp/create-server.ts mcp/tool-result.ts mcp/tools tests/cryptobot/mcp-tools.test.ts
git commit -m "feat: expose read-only CryptoBot MCP tools"
```

---

### Task 7: Build the professional Hebrew widget

**Files:**
- Create: `mcp/widget-resource.ts`
- Create: `mcp/web/src/main.tsx`
- Create: `mcp/web/src/bridge.ts`
- Create: `mcp/web/src/types.ts`
- Create: `mcp/web/src/control-center.tsx`
- Create component files for status, overview, AlgoBot, Bybit bots, portfolio, risk/system
- Create: `mcp/web/src/styles.css`
- Create: `tests/cryptobot/widget-contract.test.ts`

**Interfaces:**
- Resource URI: `ui://cryptobot/control-center.html`.
- Widget refreshes through `window.openai.callTool` only.
- Fullscreen uses `window.openai.requestDisplayMode({ mode: "fullscreen" })`.

- [ ] **Step 1: Write widget source-contract tests**

Assert RTL, the five Hebrew areas, fullscreen capability, no direct Bybit fetch, no Supabase `createClient`, no write tool, and no fixed bottom nav that collides with the ChatGPT composer.

- [ ] **Step 2: Implement host bridge with capability detection**

Feature-detect `window.openai`, expose typed `callReadTool` and `requestFullscreen`, and convert host/tool failures into display states instead of unhandled exceptions.

- [ ] **Step 3: Implement five-area navigation**

Mobile: sticky compact status bar + horizontal tabs, >=44px targets, no bottom navigation. Desktop/tablet: compact RTL side navigation + multi-column command center.

- [ ] **Step 4: Implement Overview**

Display equity, day/week/month P&L, drawdown, deployed capital, open positions, AlgoBot summary, Bybit bot summary, latest decision, highest-severity alert, overall state.

- [ ] **Step 5: Keep AlgoBot and Bybit bots visually separate**

Use explicit captions:
- `AlgoBot — ביצועי המערכת שלנו`
- `בוטים של Bybit — ביצועים נפרדים`

- [ ] **Step 6: Implement Portfolio and Risk/System**

Financial values are LTR inside RTL containers. Stale data shows a visible age label.

- [ ] **Step 7: Implement fullscreen fallback**

`מסך מלא` requests fullscreen; if unsupported/rejected, inline remains fully usable.

- [ ] **Step 8: Build, test, commit**

```bash
npm run mcp:build-widget
npm run test:cryptobot
git add mcp/widget-resource.ts mcp/web tests/cryptobot/widget-contract.test.ts
git commit -m "feat: build Hebrew CryptoBot ChatGPT control center"
```

---

### Task 8: Add MCP HTTP transport, OAuth metadata, and health endpoint

**Files:**
- Create: `mcp/server.ts`
- Extend: `tests/cryptobot/auth.test.ts`
- Create: `tests/cryptobot/read-only-boundary.test.ts`

**Interfaces:**
- `GET /.well-known/oauth-protected-resource`
- `POST /mcp`
- `GET /healthz`
- 401 responses include `WWW-Authenticate`.

- [ ] **Step 1: Write HTTP contract tests**

Verify health is public but contains no account data; unauthenticated MCP is 401; resource metadata advertises `cryptobot.read`; valid principal reaches the transport.

- [ ] **Step 2: Implement protected resource metadata**

```json
{
  "resource": "<CRYPTOBOT_PUBLIC_MCP_URL>",
  "authorization_servers": ["<CRYPTOBOT_OAUTH_ISSUER>"],
  "scopes_supported": ["cryptobot.read"]
}
```

- [ ] **Step 3: Implement stateless Streamable HTTP per authorized request**

Verify bearer token -> create principal -> create a fresh principal-bound MCP server -> create stateless transport -> handle request -> close. Never cache a principal-bound server across users.

- [ ] **Step 4: Map external errors to safe codes**

Allowed external errors: `authentication_required`, `forbidden`, `invalid_request`, `source_unavailable`, `not_found`, `internal_error`. Raw JWT/SQL/Bybit/service-role errors stay server-side.

- [ ] **Step 5: Add static no-write scan**

Fail if production source contains private mutation endpoints including order create/cancel, strategy create/stop, DCA/Grid create/close, transfer, or withdrawal create. The test file itself may contain these strings only as its forbidden list.

- [ ] **Step 6: Build, test, commit**

```bash
npm run mcp:build
npm run test:cryptobot
npm test
git add mcp/server.ts tests/cryptobot
git commit -m "feat: serve secured CryptoBot MCP over HTTP"
```

---

### Task 9: Harden freshness and partial-failure resilience

**Files:**
- Modify gateway modules and widget components as required
- Extend gateway/widget tests

- [ ] **Step 1: Add failure-matrix tests**

Cases:
- Bybit stale + AlgoBot healthy => `limited`, AlgoBot still visible.
- AlgoBot stale => UI does not claim healthy.
- Risk unavailable => UI reflects persisted protection state; it does not command a stop.
- Bot-detail query fails => portfolio can still render.
- Widget refresh fails => last successful values remain visible with `מקור לא זמין` and age.

- [ ] **Step 2: Implement independent panel degradation**

A single optional source failure never blanks the entire control center.

- [ ] **Step 3: Add bounded refresh behavior**

Default while open:
- overview/system: 30s;
- Bybit account/bots: 60s;
- strategy detail: on tab open + manual refresh.

Timers are cleaned up on unmount and repeated failures do not create a request loop.

- [ ] **Step 4: Test and commit**

```bash
npm run test:cryptobot
npm run mcp:build
git add src/cryptobot mcp/web tests/cryptobot
git commit -m "feat: harden CryptoBot freshness and partial failures"
```

---

### Task 10: MCP Inspector and ChatGPT Developer Mode acceptance

**Files:**
- Create: `docs/cryptobot/chatgpt-control-center-runbook.md`

- [ ] **Step 1: Start MCP locally**

```bash
PORT=8788 npm run mcp:dev
```

- [ ] **Step 2: Verify health and auth challenge**

```bash
curl -i http://localhost:8788/healthz
curl -i -X POST http://localhost:8788/mcp \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

Expected: health 200; MCP without auth 401 + `WWW-Authenticate`.

- [ ] **Step 3: Verify with MCP Inspector**

Check exactly eight tools, read-only annotations, schema-valid data, only `open_control_center` returns UI, and unauthorized callers receive no private data.

- [ ] **Step 4: Connect public HTTPS `/mcp` endpoint in ChatGPT Developer Mode**

Refresh/reconnect the app after metadata/resource changes.

- [ ] **Step 5: Visual acceptance matrix**

Verify 320px, 360px, 390px, tablet, desktop fullscreen; RTL; no clipped values; composer available in fullscreen; tab state persists; stale labels visible; data refresh does not recreate the widget unnecessarily.

- [ ] **Step 6: Verify live source separation**

Compare total account equity, AlgoBot P&L, Bybit bot equity/P&L, open positions, and system health. No Bybit bot metric appears under AlgoBot.

- [ ] **Step 7: Write runbook**

Record build commands, env variable names only, MCP URL, issuer/audience setup, health check, rollback commit, and how to disable only the ChatGPT-facing MCP service without touching AlgoBot.

- [ ] **Step 8: Commit**

```bash
git add docs/cryptobot/chatgpt-control-center-runbook.md
git commit -m "docs: add CryptoBot ChatGPT control center runbook"
```

---

### Task 11: Final V1 verification and release gate

**Files:**
- No feature additions; only verified defect fixes/evidence.

- [ ] **Step 1: Run full verification**

```bash
npm run test:cryptobot
npm test
npm run lint
npm run mcp:build
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Verify no-write invariants**

Confirm no V1 MCP write tool, no direct widget Bybit call, no direct widget Supabase call, no bundled service-role secret, Bybit key remains globally read-only, `trading_enabled=false`, `withdrawals_enabled=false`.

- [ ] **Step 3: Verify approved V1 acceptance criteria**

Evidence must show: ChatGPT opens the control center; fullscreen+composer works; Hebrew RTL; five primary areas; AlgoBot/Bybit bots separated; current Supabase data; freshness; explicit stale/unavailable; authorization enforced; no secret output; no Bybit write request possible; widget survives refresh; mobile works without external user-facing app; AlgoBot runs independently of ChatGPT.

- [ ] **Step 4: Open review PR**

Title:

```text
CryptoBot ChatGPT Control Center V1 — read-only command center
```

PR body states read-only scope, source separation, auth model, live Bybit key remains read-only, test evidence, deployment path, rollback path.

- [ ] **Step 5: Merge gate**

Do not merge until exact-head CI, tests, visual acceptance, secret scan, and review are green.

## Plan Self-Review Result

- Spec coverage: approved architecture, security, UI, freshness, resilience, explainability, and acceptance requirements are mapped to tasks.
- Technical clarification: `open_control_center` is the single render-only tool needed for the approved decoupled data/render pattern. All eight tools remain read-only.
- Production safety: the only planned Bybit API expansion is documented `GET /v5/strategy/list`; optional failure is isolated and does not weaken global `readOnly === 1` validation.
- Type consistency: gateway method names match MCP handlers and widget read calls.
- Placeholder scan: the plan contains concrete files, interfaces, commands, test expectations, and release gates.