# ALGOBOT P0 Production Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PostgreSQL-backed, crash-safe, single-writer, fail-closed ALGOBOT CANARY execution/recovery engine while preserving the existing Spot-only 10 USDT/order and 100 USDT cumulative limits and human approval gate.

**Architecture:** Supabase/PostgreSQL becomes the durable coordination authority for ledger, reservations, positions, recovery and fencing; Bybit remains authoritative for exchange facts. Execution persists intent before dispatch, reconciles only from exchange evidence, and enables trading only after deterministic startup recovery proves all invariants.

**Tech Stack:** Node.js ESM, Node test runner, PostgreSQL/Supabase SQL migrations, Bybit V5 REST, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-algobot-p0-production-architecture-design.md`

## Global Constraints
- Do not transmit any real Bybit LIVE order during implementation or verification.
- Keep `humanApproved === true` mandatory.
- Spot only; BTCUSDT CANARY scope; leverage exactly 1/no leverage semantics.
- Maximum 10 USDT per order and 100 USDT cumulative CANARY authorization.
- No Futures, derivatives, margin, withdrawals or unrestricted LIVE mode.
- No merge to `main`.
- Strict TDD: RED -> verify RED -> minimal implementation -> GREEN -> regression -> commit.
- Real PostgreSQL integration tests are mandatory for locking, concurrent reservations and fencing.

---

### Task 1: PostgreSQL execution schema and invariants

**Files:**
- Create: `crypto-market-monitor-full-source/supabase/migrations/20260905_algobot_p0_execution.sql`
- Create: `crypto-market-monitor-full-source/tests/algo-p0-postgres-schema.test.mjs`

**Interfaces:**
- Produces tables `execution_ledger`, `position_lifecycle`, `bot_state_meta`, `canary_reservations`.
- Produces SQL functions `algobot_reserve_canary(...)`, `algobot_release_canary_reservation(...)`, `algobot_acquire_executor(...)`, `algobot_assert_fence(...)`.

- [ ] **Step 1: Write failing schema tests** that connect to the test PostgreSQL URL, apply the migration in an isolated schema/database, assert all required tables/columns/check constraints/unique `order_link_id`, and reject illegal statuses, negative quantities and duplicate order links.
- [ ] **Step 2: Run RED** with `node --test tests/algo-p0-postgres-schema.test.mjs`; expected failure: migration/functions do not exist.
- [ ] **Step 3: Implement migration** with UUID primary keys, status/reconciliation CHECK constraints, non-negative numeric checks, timestamps, indexes, reservation foreign key to execution ledger, and singleton coordination row.
- [ ] **Step 4: Run GREEN** with the same command and verify every schema assertion passes.
- [ ] **Step 5: Run existing isolated ALGO regression suite** using the repository's current ALGO test command; no regression accepted.
- [ ] **Step 6: Commit** `test/db + migration` as `feat: add persistent ALGOBOT execution schema`.

### Task 2: Atomic CANARY budget reservation

**Files:**
- Modify: `crypto-market-monitor-full-source/supabase/migrations/20260905_algobot_p0_execution.sql`
- Create: `crypto-market-monitor-full-source/algo/canary-budget-store.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-p0-canary-budget-postgres.test.mjs`

**Interfaces:**
- `createCanaryBudgetStore({ pool, maxOrderNotionalUsdt: 10, maxCumulativeNotionalUsdt: 100 })`
- `reserve({ orderLinkId, requestedNotionalUsdt, executorFenceToken }) -> { reservationId, reservedNotionalUsdt, totalAuthorizedUsdt }`
- `release({ reservationId, reason, executorFenceToken })`
- `commit({ reservationId, filledNotionalUsdt, executorFenceToken })`

- [ ] **Step 1: Write failing integration tests** for <=10/order, restart persistence, two concurrent workers racing for the final budget, release after proven non-dispatch, and no double-count on repeated commit.
- [ ] **Step 2: Run RED**: `node --test tests/algo-p0-canary-budget-postgres.test.mjs`; expected missing store/function failures.
- [ ] **Step 3: Implement SQL reservation transaction** locking `bot_state_meta` with `FOR UPDATE`; validate current fence, per-order cap and aggregate committed+reserved cap before inserting reservation.
- [ ] **Step 4: Implement `canary-budget-store.mjs`** as a thin transactional adapter; never compute the safety cap from process memory.
- [ ] **Step 5: Run GREEN**, then repeat the concurrency test multiple times to prove no oversubscription above 100 USDT.
- [ ] **Step 6: Run regression suite and commit** `feat: make CANARY budget atomic and persistent`.

### Task 3: Single-writer executor fencing

**Files:**
- Modify: `crypto-market-monitor-full-source/supabase/migrations/20260905_algobot_p0_execution.sql`
- Create: `crypto-market-monitor-full-source/algo/executor-fence.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-p0-executor-fence-postgres.test.mjs`

**Interfaces:**
- `createExecutorFence({ pool, ownerId, leaseMs })`
- `acquire() -> { ownerId, fenceToken, leaseExpiresAt }`
- `renew({ fenceToken })`
- `assertCurrent({ fenceToken })`
- `release({ fenceToken })`

- [ ] **Step 1: Write failing PostgreSQL race tests** where two instances acquire concurrently and assert exactly one owns `TRADING_ENABLED`; then let a newer owner acquire and prove the stale token cannot reserve or mutate execution state.
- [ ] **Step 2: Run RED** and capture the expected missing-fence behavior.
- [ ] **Step 3: Implement monotonic fencing generation and DB-enforced ownership** using row locking/advisory locking consistent with the migration; every authorizing function checks the token transactionally.
- [ ] **Step 4: Run GREEN** including stale-writer rejection.
- [ ] **Step 5: Regression and commit** `feat: add database executor fencing`.

### Task 4: Persistent execution ledger store

**Files:**
- Create: `crypto-market-monitor-full-source/algo/execution-store.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-p0-execution-store.test.mjs`

**Interfaces:**
- `createExecutionStore({ pool })`
- `createExecution({ orderLinkId, symbol, side, requestedQty, requestedNotional, fenceToken })`
- `markInFlight(...)`, `applyExchangeEvidence(...)`, `markUnknown(...)`, `getByOrderLinkId(...)`, `listUnresolved()`.

- [ ] **Step 1: Write RED tests** for unique persistent idempotency across fresh store instances, legal state transitions, illegal transition rejection, and exchange-evidence fields for partial/full fills.
- [ ] **Step 2: Run RED**.
- [ ] **Step 3: Implement minimal store** with DB transactions and fencing checks on execution-authorizing transitions.
- [ ] **Step 4: Run GREEN** and verify a recreated process/store sees prior execution history.
- [ ] **Step 5: Regression and commit** `feat: add persistent execution ledger store`.

### Task 5: Bybit transport evidence for fills and balances

**Files:**
- Modify: `crypto-market-monitor-full-source/algo/bybit-v5-readonly-transport.mjs`
- Modify/Create focused transport tests under `crypto-market-monitor-full-source/tests/` following existing naming conventions.

**Interfaces:**
- Preserve `placeOrder(request)` and `reconcileOrder(request)`.
- Add `listExecutions({ orderLinkId, orderId, symbol })` or equivalent verified fill query.
- Add/read relevant Spot balance evidence required by recovery.

- [ ] **Step 1: Write failing transport tests** asserting signed GET request shape, Spot-only validation, malformed response rejection, partial-fill fields, fees, average price and no leverage/margin semantics.
- [ ] **Step 2: Run RED**.
- [ ] **Step 3: Implement minimal Bybit V5 evidence queries** without changing the strict Spot order body.
- [ ] **Step 4: Run GREEN**, including existing order-transport tests.
- [ ] **Step 5: Commit** `feat: add verified Bybit execution evidence`.

### Task 6: Refactor live adapter to durable dispatch lifecycle

**Files:**
- Modify: `crypto-market-monitor-full-source/algo/bybit-live-adapter.mjs`
- Modify/Create: focused adapter tests in `crypto-market-monitor-full-source/tests/`.

**Interfaces:**
- `createBybitLiveAdapter({ ..., executionStore, canaryBudgetStore, executorFence, recoveryGate })`.
- `submitCanaryOrder(request)` remains the guarded external entrypoint.

- [ ] **Step 1: Write RED tests** proving RAM restart cannot reset exposure/idempotency, DB `CREATED` and reservation precede `IN_FLIGHT`/Bybit call, duplicate `orderLinkId` returns persistent result or conflict, and stale fence cannot dispatch.
- [ ] **Step 2: Add explicit RED test for the current synthetic success path**: transport without reconciliation evidence must produce `UNKNOWN`/lock, never `FILLED`.
- [ ] **Step 3: Run RED**.
- [ ] **Step 4: Remove `cumulativeCommittedNotionalUsdt`, `executedOrders`, and `inFlightOrders` as safety authorities; wire persistent stores and fence.** Preserve live-canary policy, risk, qualification, permissions, Spot/no-leverage and human approval.
- [ ] **Step 5: Delete synthetic `orderStatus: 'Filled'` fallback.** Missing exchange evidence persists `UNKNOWN`, marks reconciliation unhealthy and locks execution.
- [ ] **Step 6: Run GREEN and full adapter/transport regression**.
- [ ] **Step 7: Commit** `refactor: make Bybit CANARY execution crash safe`.

### Task 7: Partial-fill position accounting

**Files:**
- Create: `crypto-market-monitor-full-source/algo/position-manager.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-p0-position-manager.test.mjs`

**Interfaces:**
- `createPositionManager({ pool, executionStore, executorFence })`
- `applyBuyFill({ execution, fills, fenceToken })`
- `requestExit({ positionId, reason, fenceToken })`
- `applySellFill({ positionId, execution, fills, fenceToken })`
- `listManagedPositions()`.

- [ ] **Step 1: Write RED tests** for partial BUY actual quantity, average price/fees, full BUY -> OPEN, partial SELL remaining quantity, full SELL -> CLOSED, and SELL quantity never exceeding verified available position.
- [ ] **Step 2: Run RED**.
- [ ] **Step 3: Implement persistent lifecycle transitions** `OPENING -> OPEN -> EXIT_PENDING -> CLOSING -> CLOSED`; derive all quantities/PnL from verified fills only.
- [ ] **Step 4: Run GREEN**.
- [ ] **Step 5: Regression and commit** `feat: add persistent partial-fill position lifecycle`.

### Task 8: Fail-closed startup recovery gate

**Files:**
- Create: `crypto-market-monitor-full-source/algo/recovery-manager.mjs`
- Modify: runtime/entrypoint file identified by repository mapping that currently instantiates the Bybit execution path.
- Create: `crypto-market-monitor-full-source/tests/algo-p0-recovery-manager.test.mjs`

**Interfaces:**
- `createRecoveryManager({ executionStore, positionManager, canaryBudgetStore, executorFence, transport })`
- `recover() -> { tradingEnabled, blockers, reconciledExecutions, reconciledPositions }`
- `isTradingEnabled()` defaults false until successful recovery.

- [ ] **Step 1: Write RED tests** for initial locked state; unresolved IN_FLIGHT/UNKNOWN; open position; accounting mismatch; Supabase unavailable; Bybit unavailable/timeout; malformed payload; position discrepancy; fencing failure.
- [ ] **Step 2: Write RED signal-freeze test**: a strategy signal arriving while `recover()` is pending must not call `placeOrder` or create a dispatchable execution.
- [ ] **Step 3: Run RED**.
- [ ] **Step 4: Implement boot sequence** ownership -> DB state -> unresolved executions/positions -> Bybit evidence -> ledger/fill/balance reconciliation -> budget verification -> position verification -> enable only with zero blockers.
- [ ] **Step 5: Wire runtime execution through recovery gate** so no execution path bypasses it.
- [ ] **Step 6: Run GREEN**, regression and commit `feat: add fail-closed startup recovery gate`.

### Task 9: Crash-safe autonomous exit recovery

**Files:**
- Modify: `crypto-market-monitor-full-source/algo/position-manager.mjs`
- Modify: `crypto-market-monitor-full-source/algo/recovery-manager.mjs`
- Create/Modify: focused recovery/position tests.

**Interfaces:**
- `resumePositionManagement({ positionId, fenceToken })`.
- Exit persistence always precedes SELL creation/dispatch.

- [ ] **Step 1: Write RED restart tests** for process death while `OPEN`, after `EXIT_PENDING` before SELL, while `CLOSING`, and SELL `IN_FLIGHT` after transmission.
- [ ] **Step 2: Assert no blind duplicate SELL**; recovery must query by persisted `orderLinkId` before any resubmission.
- [ ] **Step 3: Run RED**.
- [ ] **Step 4: Implement deterministic resume/reconciliation**; ambiguous SELL -> execution `UNKNOWN` + trading locked.
- [ ] **Step 5: Run GREEN**, regression and commit `feat: make autonomous exits restart safe`.

### Task 10: Destructive failure-injection acceptance suite

**Files:**
- Create: `crypto-market-monitor-full-source/tests/failure-injection.test.mjs`
- Modify focused test helpers only where necessary.

**Interfaces:**
- Deterministic crash/fault hooks at durable boundaries; production defaults must not inject faults.

- [ ] **Step 1: Add 15 RED scenarios** exactly matching the directive: DB CREATED/pre-Bybit crash; reservation crash; transmit/network timeout; accepted/pre-reconcile crash; OPEN crash; EXIT_PENDING crash; SELL transmit crash; partial BUY restart; partial SELL restart; Supabase outage; Bybit outage; malformed Bybit; concurrent budget race; executor race; signal during recovery.
- [ ] **Step 2: Run RED** and confirm each scenario fails for the intended missing behavior, not fixture/setup errors.
- [ ] **Step 3: Add only the minimal hooks/fixes needed** so every scenario ends in deterministic recovery or FAIL_CLOSED.
- [ ] **Step 4: Run GREEN**: `node --test tests/failure-injection.test.mjs`.
- [ ] **Step 5: Run PostgreSQL concurrency suites and all isolated ALGO tests**.
- [ ] **Step 6: Commit** `test: prove ALGOBOT P0 crash recovery invariants`.

### Task 11: GitHub CI and reproducible P0 evidence

**Files:**
- Create: `.github/workflows/algo-v2-p0-persistent-recovery.yml`
- Create: `docs/superpowers/verification/2026-09-05-algobot-p0-production-acceptance.md`

**Interfaces:**
- CI provisions PostgreSQL service, applies migration, runs concurrency/fencing/failure-injection tests and existing isolated ALGO regression suite.

- [ ] **Step 1: Write CI workflow** with PostgreSQL service health check and test DB URL; never expose Bybit live credentials to order-placement tests and never call a real order endpoint.
- [ ] **Step 2: Run/trigger CI by pushing commits to the P0 branch.**
- [ ] **Step 3: Inspect every job/log**; any failure blocks Definition of Done.
- [ ] **Step 4: Populate acceptance document** with exact branch, commit SHAs, migrations, test counts, PostgreSQL race evidence, all 15 failure scenarios PASS/FAIL, GitHub Actions URLs, unresolved risks, and explicit `NO REAL ORDER WAS TRANSMITTED` statement.
- [ ] **Step 5: Final independent checklist** against every P0 Definition-of-Done item in the design/directive; do not mark autonomous CANARY authorized unless every item is reproducibly proven.
- [ ] **Step 6: Commit** `ci: add ALGOBOT P0 acceptance verification` and STOP before any real trade.

## Self-review result
- Spec coverage: persistence, atomic caps, crash-safe reservations, idempotency, fencing, fail-closed boot, synthetic-success removal, partial fills, persistent exits, all 15 failure injections and CI evidence are each mapped to explicit tasks.
- No placeholder implementation steps are authorized; exact interfaces and verification commands are named where repository-independent. The runtime entrypoint is intentionally selected from the mapped branch before Task 8 modification rather than guessed.
- Safety constraints remain unchanged throughout; no task authorizes real order transmission or removal of human approval.
