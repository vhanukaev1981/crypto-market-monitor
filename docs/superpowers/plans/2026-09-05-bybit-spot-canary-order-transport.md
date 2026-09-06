# Bybit Spot Canary Order Transport Implementation Plan

> **For implementation:** Execute task-by-task with TDD. No production order may be sent by tests or CI.

**Goal:** Complete the Bybit V5 Spot order transport and harden the $100 live canary so a first real order can only occur after fresh exact-HEAD qualification and explicit human approval.

**Architecture:** Keep the existing fail-closed `BybitLiveAdapter` as the policy boundary. Extend the signed V5 transport with the minimum POST `/v5/order/create` and read-only reconciliation operations required by the adapter. Bind live-canary qualification to fresh evidence from the current commit instead of accepting a caller-authored PASS object. Keep CI validation non-trading: mocks for order transport and authenticated read-only permission/account checks only.

**Tech Stack:** Node.js ESM, node:test, node:crypto HMAC-SHA256, Bybit V5 REST, GitHub Actions self-hosted non-US runner.

---

### Task 1: Signed Spot order transport

**Files:**
- Create: `crypto-market-monitor-full-source/tests/algo-bybit-order-transport.test.mjs`
- Modify: `crypto-market-monitor-full-source/algo/bybit-v5-readonly-transport.mjs`

1. Add tests proving `placeOrder` signs POST payload as `timestamp + apiKey + recvWindow + JSON body`, targets `/v5/order/create`, uses JSON content type, and never leaks the secret.
2. Add rejection tests for non-Spot category, leverage/margin fields, unsupported order types, invalid symbol/side/qty, and non-zero Bybit `retCode`.
3. Verify RED before implementation.
4. Add the minimum `placeOrder` implementation required to pass.
5. Verify targeted transport tests GREEN.

### Task 2: Reconciliation transport

**Files:**
- Modify: `crypto-market-monitor-full-source/tests/algo-bybit-order-transport.test.mjs`
- Modify: `crypto-market-monitor-full-source/algo/bybit-v5-readonly-transport.mjs`

1. Add failing tests for read-only order lookup by `orderLinkId` and open-order lookup.
2. Implement signed GET reconciliation operations only.
3. Verify transport tests GREEN.

### Task 3: Exact-HEAD qualification gate

**Files:**
- Modify: `crypto-market-monitor-full-source/algo/live-readiness.mjs`
- Modify: `crypto-market-monitor-full-source/tests/algo-live-readiness.test.mjs`
- Modify: `crypto-market-monitor-full-source/algo/bybit-live-adapter.mjs`
- Modify: `crypto-market-monitor-full-source/tests/algo-bybit-live-adapter.test.mjs`

1. Add failing tests proving stale, future, failed, missing, or cross-HEAD evidence cannot authorize CANARY.
2. Implement a live-readiness evidence evaluator tied to `currentHeadSha` and a bounded freshness window.
3. Require adapter CANARY submissions to consume this trusted qualification result rather than a free-form caller PASS.
4. Verify targeted readiness and adapter tests GREEN.

### Task 4: Canary permission and symbol boundary

**Files:**
- Modify: `crypto-market-monitor-full-source/algo/bybit-live-adapter.mjs`
- Modify: `crypto-market-monitor-full-source/tests/algo-bybit-live-adapter.test.mjs`

1. Add failing tests requiring read-write Spot permission, withdrawal disabled, no derivative permission, and an explicit Spot symbol allowlist.
2. Implement fail-closed checks before order transport is engaged.
3. Verify targeted adapter tests GREEN.

### Task 5: Full safety regression and authenticated dry validation

**Files:**
- Modify only if needed: `.github/workflows/algo-v2-bybit-live-readiness.yml`

1. Run all isolated ALGO tests on the exact branch HEAD.
2. Run authenticated Bybit permission/account diagnostic on `[self-hosted, linux, x64, bybit-non-us]`.
3. Confirm diagnostic reports order transport not engaged.
4. Do not call `/v5/order/create` from CI.
5. Stop if any gate is not PASS.

### Task 6: First-order approval gate

No code or exchange action in this task until all previous verification is fresh and PASS.

1. Present exact candidate order (symbol, side, type, notional <= 10 USDT, current committed canary exposure).
2. Obtain explicit human approval for that exact order immediately before submission.
3. Submit at most one order with unique `orderLinkId`.
4. Reconcile exchange state before any subsequent order.
5. On ambiguous API/state response, halt and do not retry blindly.

**Invariant:** Spot only; leverage=1; <=10 USDT per order; <=100 USDT aggregate committed canary capital; withdrawal/transfer forbidden; derivatives forbidden; fail closed on uncertainty.
