# Bybit Live Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed Bybit Spot adapter that can validate a real account read-only and later permit explicitly approved canary orders capped at $10/order and $100 total exposure.

**Architecture:** Keep exchange transport separate from strategy and risk logic. Strategy output must pass the existing live-readiness/canary policy before any authenticated write. Implement READ_ONLY first; CANARY order submission remains gated by explicit human approval and credentials with withdrawals disabled. LIVE remains disabled.

**Tech Stack:** Node.js 22 ESM, node:test, Bybit V5 REST API, GitHub Actions.

**Spec:** Approved in chat on 2026-09-04: Strategy -> Risk Engine -> Live Readiness Gate -> Bybit Adapter -> Order; READ_ONLY/CANARY/LIVE modes; Spot only; leverage 1; $10 max/order; $100 max exposure; fail closed; no withdrawal permission.

## Global Constraints

- SPOT only; leverage must equal 1.
- CANARY maximum order notional: 10 USDT.
- CANARY maximum cumulative exposure: 100 USDT.
- Withdrawal permission must be absent.
- Missing/invalid credentials, stale qualification, failed reconciliation, or missing explicit approval blocks writes.
- Secrets must never be committed or logged.
- LIVE mode remains disabled in this plan.

---

### Task 1: Adapter contract and fail-closed mode tests

**Files:**
- Create: `crypto-market-monitor-full-source/tests/algo-bybit-live-adapter.test.mjs`
- Create: `crypto-market-monitor-full-source/algo/bybit-live-adapter.mjs`

**Interfaces:**
- Produces: `createBybitLiveAdapter(config)` with `getAccountSnapshot()` and gated `submitCanaryOrder(request)`.

- [ ] Write failing tests for READ_ONLY default, unsupported LIVE mode, missing credentials, and no order transport call when blocked.
- [ ] Run the isolated test and verify RED.
- [ ] Implement the minimal adapter contract and mode validation.
- [ ] Run the isolated test and verify GREEN.
- [ ] Commit.

### Task 2: Signed read-only account connectivity and permission validation

**Files:**
- Modify: `crypto-market-monitor-full-source/algo/bybit-live-adapter.mjs`
- Modify: `crypto-market-monitor-full-source/tests/algo-bybit-live-adapter.test.mjs`

**Interfaces:**
- Produces: normalized account snapshot and `validateApiPermissions()` result without exposing secret material.

- [ ] Add failing transport-mock tests for signed balance/account-info reads, API error handling, redaction, and rejection when withdrawal permission is present or permissions cannot be established.
- [ ] Run tests and verify RED.
- [ ] Implement HMAC signing/transport injection and normalized read-only calls.
- [ ] Run tests and verify GREEN.
- [ ] Commit.

### Task 3: Existing readiness gate integration for CANARY

**Files:**
- Modify: `crypto-market-monitor-full-source/algo/bybit-live-adapter.mjs`
- Modify: `crypto-market-monitor-full-source/tests/algo-bybit-live-adapter.test.mjs`
- Reuse: `crypto-market-monitor-full-source/algo/live-canary-policy.mjs`

**Interfaces:**
- Consumes: existing live canary/readiness policy.
- Produces: `submitCanaryOrder()` that can reach transport only after all gates pass.

- [ ] Add failing tests for Spot-only, leverage=1, explicit approval, fresh qualification, <=10 USDT order, <=100 USDT cumulative exposure, and reconciliation/risk failure.
- [ ] Verify RED.
- [ ] Wire the adapter to the existing policy with fail-closed defaults.
- [ ] Verify GREEN and full isolated ALGO regression.
- [ ] Commit.

### Task 4: Read-only diagnostic entrypoint and CI

**Files:**
- Create: `crypto-market-monitor-full-source/scripts/check-bybit-live-readiness.mjs`
- Create or modify: `.github/workflows/algo-v2-bybit-live-readiness.yml`
- Test: `crypto-market-monitor-full-source/tests/algo-bybit-live-adapter.test.mjs`

**Interfaces:**
- Consumes environment secrets at runtime only.
- Produces a redacted PASS/FAIL readiness report; never submits an order.

- [ ] Add tests proving the diagnostic cannot call order endpoints and never prints secrets.
- [ ] Verify RED.
- [ ] Implement diagnostic and manual-only workflow using GitHub Secrets.
- [ ] Verify GREEN and full ALGO regression.
- [ ] Commit.

### Task 5: Review and qualification

- [ ] Review branch diff for secret leakage and bypass paths.
- [ ] Run full ALGO regression.
- [ ] Run existing Bybit native validation on the branch/PR.
- [ ] Open a Draft PR to `agent/algo-v2-hardening-v1` with READ_ONLY as the only permitted real-account operation.
- [ ] Do not merge and do not send a real order in this task.
