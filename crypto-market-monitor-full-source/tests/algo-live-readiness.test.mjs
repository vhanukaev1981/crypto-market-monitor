import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLiveReadiness } from '../algo/live-readiness.mjs';

const ready = (overrides = {}) => ({
  dataFresh: true,
  riskEngineHealthy: true,
  executionEngineHealthy: true,
  reconciliationHealthy: true,
  oosLockActive: true,
  leverageEnabled: false,
  marketType: 'SPOT',
  canaryBudgetUsd: 100,
  maxOrderNotionalUsd: 10,
  humanApproval: true,
  withdrawalPermission: false,
  ...overrides,
});

test('live readiness passes only for approved USD 100 spot canary', () => {
  assert.deepEqual(evaluateLiveReadiness(ready()), { status: 'PASS', blockers: [] });
});

test('live readiness fails closed when any safety invariant is missing', () => {
  const cases = [
    ['DATA_NOT_FRESH', { dataFresh: false }],
    ['RISK_ENGINE_UNHEALTHY', { riskEngineHealthy: false }],
    ['EXECUTION_ENGINE_UNHEALTHY', { executionEngineHealthy: false }],
    ['RECONCILIATION_UNHEALTHY', { reconciliationHealthy: false }],
    ['OOS_LOCK_INACTIVE', { oosLockActive: false }],
    ['LEVERAGE_MUST_BE_DISABLED', { leverageEnabled: true }],
    ['SPOT_ONLY_REQUIRED', { marketType: 'FUTURES' }],
    ['CANARY_BUDGET_MUST_EQUAL_100_USD', { canaryBudgetUsd: 101 }],
    ['MAX_ORDER_NOTIONAL_EXCEEDED', { maxOrderNotionalUsd: 10.01 }],
    ['HUMAN_APPROVAL_REQUIRED', { humanApproval: false }],
    ['WITHDRAWAL_PERMISSION_MUST_BE_DISABLED', { withdrawalPermission: true }],
  ];
  for (const [reason, overrides] of cases) {
    const result = evaluateLiveReadiness(ready(overrides));
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blockers.includes(reason));
  }
});

test('malformed or missing input is blocked', () => {
  const result = evaluateLiveReadiness();
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.length > 0);
});
