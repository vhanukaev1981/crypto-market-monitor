import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePaperReadiness } from '../algo/paper-readiness.mjs';

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
