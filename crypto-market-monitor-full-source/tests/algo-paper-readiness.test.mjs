import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePaperReadiness, evaluatePaperReadinessFromEvidence } from '../algo/paper-readiness.mjs';

test('paper readiness is READY only when all safety evidence is healthy', () => {
  const result = evaluatePaperReadiness({
    dataFresh: true,
    riskEngineHealthy: true,
    executionEngineHealthy: true,
    reconciliationHealthy: true,
    oosLockActive: true,
    liveTradingEnabled: false,
    leverageEnabled: false,
  });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.blockers, []);
});

test('paper readiness fails closed and reports every blocker', () => {
  const result = evaluatePaperReadiness({
    dataFresh: false,
    riskEngineHealthy: false,
    executionEngineHealthy: true,
    reconciliationHealthy: false,
    oosLockActive: false,
    liveTradingEnabled: true,
    leverageEnabled: true,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, [
    'DATA_NOT_FRESH',
    'RISK_ENGINE_UNHEALTHY',
    'RECONCILIATION_UNHEALTHY',
    'OOS_LOCK_INACTIVE',
    'LIVE_TRADING_MUST_BE_DISABLED',
    'LEVERAGE_MUST_BE_DISABLED',
  ]);
});

const HEAD = '2c39ef9a48997554484794d71015eb81d41e52e0';
const evidence = (overrides = {}) => ({
  result: 'PASS',
  checkedAtMs: 9000,
  headSha: HEAD,
  ...overrides,
});

test('integrated readiness requires fresh PASS evidence from the same HEAD', () => {
  const result = evaluatePaperReadinessFromEvidence({
    nowMs: 10000,
    maxEvidenceAgeMs: 2000,
    currentHeadSha: HEAD,
    evidence: {
      data: evidence(),
      riskEngine: evidence(),
      executionEngine: evidence(),
      reconciliation: evidence(),
      oosLock: evidence(),
    },
    liveTradingEnabled: false,
    leverageEnabled: false,
  });
  assert.deepEqual(result, {
    status: 'READY',
    blockers: [],
    evidenceHeadSha: HEAD,
  });
});

test('integrated readiness fails closed on stale future missing failed or cross-HEAD evidence', () => {
  const result = evaluatePaperReadinessFromEvidence({
    nowMs: 10000,
    maxEvidenceAgeMs: 2000,
    currentHeadSha: HEAD,
    evidence: {
      data: evidence({ checkedAtMs: 10001 }),
      riskEngine: evidence({ checkedAtMs: 7000 }),
      executionEngine: evidence({ headSha: 'other-head' }),
      reconciliation: evidence({ result: 'FAIL' }),
    },
    liveTradingEnabled: false,
    leverageEnabled: false,
  });
  assert.deepEqual(result, {
    status: 'BLOCKED',
    blockers: [
      'DATA_NOT_FRESH',
      'RISK_ENGINE_UNHEALTHY',
      'EXECUTION_ENGINE_UNHEALTHY',
      'RECONCILIATION_UNHEALTHY',
      'OOS_LOCK_INACTIVE',
    ],
    evidenceHeadSha: HEAD,
  });
});

test('invalid readiness integration parameters fail closed', () => {
  const result = evaluatePaperReadinessFromEvidence({
    nowMs: Number.NaN,
    maxEvidenceAgeMs: -1,
    currentHeadSha: '',
    evidence: {},
    liveTradingEnabled: false,
    leverageEnabled: false,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['READINESS_EVIDENCE_INVALID']);
  assert.equal(result.evidenceHeadSha, null);
});
