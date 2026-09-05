# ALGO V2 Paper Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ALGO V2 a fail-closed, restart-safe autonomous paper-trading system with evidence-based readiness gates while live-money execution remains locked.

**Architecture:** Keep `agent/algo-v2-core-v1` as the baseline. Harden the existing Bybit Spot research/OOS, deterministic risk engine, paper executor, portfolio/P&L and workflow modules rather than replacing them; connect them through a tested paper orchestration boundary and structured readiness checks.

**Tech Stack:** Node.js 22.13.0, ESM `.mjs`, Node test runner, GitHub Actions, Bybit public Spot archive.

**Spec:** `docs/superpowers/specs/2026-08-31-algo-v2-paper-readiness-design.md`

## Global Constraints
- Live trading remains disabled.
- No leverage.
- Do not merge to `main` until all paper-readiness gates pass.
- Maximum drawdown halt: 5%.
- Entry allocation cap: 25%.
- Emergency continuous exposure cap: 30%.
- Research window ends at 2024-12; 2025-01 onward remains blind OOS until candidate freeze.
- Strategy V1.2 thresholds remain frozen during validation.
- Invalid, stale, incomplete, or inconsistent state fails closed.

---

### Task 1: Establish deterministic regression baseline

**Files:**
- Inspect: `crypto-market-monitor-full-source/tests/*.test.mjs`
- Inspect: `.github/workflows/algo-v2-bybit-spot-research.yml`
- Inspect: `.github/workflows/algo-v2-bybit-validation.yml`

**Interfaces:**
- Consumes: existing Node test suite and GitHub workflow definitions.
- Produces: verified baseline and exact classification of CI failures versus GitHub approval/policy blocks.

- [ ] **Step 1:** Enumerate isolated ALGO tests and workflow triggers.
- [ ] **Step 2:** Run `node --test` over all `tests/*.test.mjs` except `rendered-html.test.mjs` in a Node 22.13.0-capable environment.
- [ ] **Step 3:** Record any failing test by file, assertion, and owning module; do not classify `action_required` as a code failure without a job/log failure.
- [ ] **Step 4:** Inspect GitHub check suites/runs for the `action_required` runs and document whether approval/policy or executable code caused the block.
- [ ] **Step 5:** Commit only if a repository change is required.

### Task 2: Harden canonical Spot data quality

**Files:**
- Modify if required: `crypto-market-monitor-full-source/algo/bybit-spot-archive.mjs`
- Modify if required: `crypto-market-monitor-full-source/algo/hourly-data-quality.mjs`
- Modify if required: `crypto-market-monitor-full-source/algo/spot-research-window.mjs`
- Test: relevant `crypto-market-monitor-full-source/tests/*.test.mjs`

**Interfaces:**
- Consumes: Bybit Spot trade rows and requested research window.
- Produces: validated 1H candles or a deterministic blocking reason code.

- [ ] **Step 1:** Add a failing test for each uncovered invariant: duplicate hour, missing hour, non-monotonic timestamp, invalid OHLCV, stale terminal candle, and request crossing into 2025-01.
- [ ] **Step 2:** Run each new test and verify it fails for the intended reason.
- [ ] **Step 3:** Implement the smallest fail-closed validation needed to satisfy the tests without changing strategy thresholds.
- [ ] **Step 4:** Run the focused tests, then the isolated ALGO regression suite.
- [ ] **Step 5:** Commit data-quality hardening.

### Task 3: Prove candidate freeze and OOS isolation

**Files:**
- Modify if required: `crypto-market-monitor-full-source/algo/algo-v2-candidate-freeze.mjs`
- Modify if required: `crypto-market-monitor-full-source/algo/algo-v2-blind-oos.mjs`
- Test: `crypto-market-monitor-full-source/tests/algo-candidate-freeze.test.mjs`
- Test: `crypto-market-monitor-full-source/tests/algo-blind-oos.test.mjs`

**Interfaces:**
- Consumes: frozen candidate metadata/configuration and requested evaluation window.
- Produces: immutable candidate identity plus authorized blind-OOS evaluation or `OOS_WINDOW_LOCKED`.

- [ ] **Step 1:** Add failing tests proving candidate identity/configuration cannot silently change between freeze and OOS evaluation and that research paths cannot read 2025+.
- [ ] **Step 2:** Run tests and confirm intentional failure.
- [ ] **Step 3:** Add deterministic candidate/config hash validation and strict window authorization if absent.
- [ ] **Step 4:** Run focused OOS/freeze tests and isolated ALGO regression.
- [ ] **Step 5:** Commit OOS-integrity hardening.

### Task 4: Enforce risk-to-execution boundary

**Files:**
- Modify if required: `crypto-market-monitor-full-source/algo/risk-engine.mjs`
- Modify if required: `crypto-market-monitor-full-source/algo/paper-executor.mjs`
- Create if absent: `crypto-market-monitor-full-source/algo/paper-trading-cycle.mjs`
- Test: `crypto-market-monitor-full-source/tests/algo-risk-pnl-integration.test.mjs`
- Test: `crypto-market-monitor-full-source/tests/algo-paper-executor.test.mjs`
- Create if absent: `crypto-market-monitor-full-source/tests/algo-paper-trading-cycle.test.mjs`

**Interfaces:**
- Consumes: validated market snapshot, strategy intent, risk decision, portfolio state.
- Produces: zero or one idempotent paper execution result and updated portfolio state.

- [ ] **Step 1:** Add failing tests proving REJECTED and HALT_SYSTEM can never submit a paper order; REDUCED_SIZE uses only approved notional; duplicate cycle/order IDs cannot double-fill; invalid/nonfinite notional fails closed.
- [ ] **Step 2:** Run focused tests and confirm failure before implementation.
- [ ] **Step 3:** Implement a narrow orchestration boundary that accepts only APPROVED/REDUCED_SIZE risk decisions and generates deterministic idempotency keys.
- [ ] **Step 4:** Run focused integration tests and isolated ALGO regression.
- [ ] **Step 5:** Commit risk/execution boundary.

### Task 5: Make paper state restart-safe

**Files:**
- Modify if required: `crypto-market-monitor-full-source/algo/paper-executor.mjs`
- Modify if required: `crypto-market-monitor-full-source/algo/portfolio-pnl.mjs`
- Test: `crypto-market-monitor-full-source/tests/algo-paper-executor.test.mjs`
- Test: `crypto-market-monitor-full-source/tests/algo-portfolio-pnl.test.mjs`

**Interfaces:**
- Consumes: serialized v1 paper state and latest validated market snapshot.
- Produces: restored executor/portfolio state without replayed fills or altered realized P&L.

- [ ] **Step 1:** Add failing restart tests that export state, recreate the engine, re-submit the same order/cycle ID, and assert cash/position/P&L/fill count are unchanged.
- [ ] **Step 2:** Run and verify intentional failure if the invariant is not already satisfied.
- [ ] **Step 3:** Implement only missing state/version/idempotency validation; reject corrupt or unsupported state instead of repairing it heuristically.
- [ ] **Step 4:** Run restart tests and isolated ALGO regression.
- [ ] **Step 5:** Commit restart-safety hardening.

### Task 6: Add autonomous health/readiness evidence

**Files:**
- Create if absent: `crypto-market-monitor-full-source/algo/paper-readiness.mjs`
- Create if absent: `crypto-market-monitor-full-source/tests/algo-paper-readiness.test.mjs`
- Modify: `.github/workflows/algo-v2-bybit-spot-research.yml` only if a repository-level readiness check is needed.

**Interfaces:**
- Consumes: data-quality result, last cycle timestamp, risk state, executor state, portfolio metrics, OOS/freeze status.
- Produces: `{ ready: boolean, reasons: string[], snapshot: object }` with deterministic reason codes.

- [ ] **Step 1:** Add failing tests for stale data, active risk halt, corrupt executor state, missing candidate freeze, and healthy paper-ready state.
- [ ] **Step 2:** Run and confirm intended failures.
- [ ] **Step 3:** Implement the pure readiness evaluator; no exchange credentials and no live order path are permitted.
- [ ] **Step 4:** Run focused tests and full isolated ALGO regression.
- [ ] **Step 5:** Commit readiness evaluator.

### Task 7: Execute canonical research and paper-readiness gate

**Files:**
- Execute: `crypto-market-monitor-full-source/scripts/run-bybit-spot-research.mjs`
- Verify: `crypto-market-monitor-full-source/validation-results/*.json`
- Verify: `crypto-market-monitor-full-source/validation/algo-v2-candidate-freeze.json`

**Interfaces:**
- Consumes: canonical BTCUSDT Spot archive 2022-11 through 2024-12.
- Produces: research artifact, verified candidate freeze, OOS-lock evidence, regression evidence and paper-readiness decision.

- [ ] **Step 1:** Run isolated ALGO regression on Node 22.13.0.
- [ ] **Step 2:** Run canonical BTCUSDT Spot research with `--start-month 2022-11 --end-month 2024-12`.
- [ ] **Step 3:** Explicitly attempt `--end-month 2025-01` and require non-zero exit plus `OOS_WINDOW_LOCKED` and no output artifact.
- [ ] **Step 4:** Freeze/verify candidate from research data only; do not tune after freeze.
- [ ] **Step 5:** Evaluate paper-readiness gates and keep live trading locked regardless of paper result.
- [ ] **Step 6:** Update PR evidence with exact commands, hashes, artifacts and failures; do not merge to `main` until all gates pass.