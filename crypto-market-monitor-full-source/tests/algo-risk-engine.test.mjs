import test from 'node:test';
import assert from 'node:assert/strict';
import * as riskEngine from '../algo/risk-engine.mjs';

const { evaluateRisk } = riskEngine;

test('rejects trade when daily loss exceeds limit', () => {
  const result = evaluateRisk({
    portfolioEquity: 1000,
    dailyPnlPct: -1.6,
    drawdownPct: 1,
    volatilityLevel: 'normal',
    currentSymbolExposurePct: 10,
    maxSymbolExposurePct: 40,
    requestedNotional: 100,
    spreadBps: 2,
    maxSpreadBps: 10,
    estimatedSlippageBps: 2,
    maxSlippageBps: 10,
  });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.reasonCode, 'RISK_002_DAILY_LOSS');
});

test('reduces trade size at symbol exposure cap', () => {
  const result = evaluateRisk({
    portfolioEquity: 1000,
    dailyPnlPct: 0,
    drawdownPct: 0,
    volatilityLevel: 'normal',
    currentSymbolExposurePct: 35,
    maxSymbolExposurePct: 40,
    requestedNotional: 100,
    spreadBps: 2,
    maxSpreadBps: 10,
    estimatedSlippageBps: 2,
    maxSlippageBps: 10,
  });
  assert.equal(result.decision, 'REDUCED_SIZE');
  assert.equal(result.approvedNotional, 50);
  assert.equal(result.reasonCode, 'RISK_009_SYMBOL_EXPOSURE');
});

test('halts new trading above max drawdown', () => {
  const result = evaluateRisk({
    portfolioEquity: 1000,
    dailyPnlPct: 0,
    drawdownPct: 5.1,
    volatilityLevel: 'normal',
    currentSymbolExposurePct: 0,
    maxSymbolExposurePct: 40,
    requestedNotional: 100,
    spreadBps: 2,
    maxSpreadBps: 10,
    estimatedSlippageBps: 2,
    maxSlippageBps: 10,
  });
  assert.equal(result.decision, 'HALT_SYSTEM');
  assert.equal(result.reasonCode, 'RISK_003_MAX_DRAWDOWN');
});

test('reduces size by half in high volatility', () => {
  const result = evaluateRisk({
    portfolioEquity: 1000,
    dailyPnlPct: 0,
    drawdownPct: 0,
    volatilityLevel: 'high',
    currentSymbolExposurePct: 0,
    maxSymbolExposurePct: 40,
    requestedNotional: 200,
    spreadBps: 2,
    maxSpreadBps: 10,
    estimatedSlippageBps: 2,
    maxSlippageBps: 10,
  });
  assert.equal(result.decision, 'REDUCED_SIZE');
  assert.equal(result.approvedNotional, 100);
  assert.equal(result.reasonCode, 'RISK_010_VOLATILITY_REDUCTION');
});

test('reduces size by half when drawdown is between 3.5% and 5%', () => {
  const result = evaluateRisk({
    portfolioEquity: 1000,
    dailyPnlPct: 0,
    drawdownPct: 4,
    volatilityLevel: 'normal',
    currentSymbolExposurePct: 0,
    maxSymbolExposurePct: 40,
    requestedNotional: 200,
    spreadBps: 2,
    maxSpreadBps: 10,
    estimatedSlippageBps: 2,
    maxSlippageBps: 10,
  });
  assert.equal(result.decision, 'REDUCED_SIZE');
  assert.equal(result.approvedNotional, 100);
  assert.equal(result.reasonCode, 'RISK_011_DRAWDOWN_REDUCTION');
});

test('two-tier exposure control allows mark-to-market drift above entry cap but trims only above hard cap', () => {
  assert.equal(typeof riskEngine.evaluateExposureControl, 'function');

  const drift = riskEngine.evaluateExposureControl({
    portfolioEquity: 102753.2551788511,
    positionValue: 27777.627880894986,
    entryAllocationCapPct: 25,
    hardExposureCapPct: 30,
  });
  assert.equal(drift.decision, 'HOLD');
  assert.equal(drift.reasonCode, 'RISK_EXPOSURE_DRIFT_WITHIN_HARD_CAP');
  assert.equal(drift.targetPositionValue, 27777.627880894986);

  const breach = riskEngine.evaluateExposureControl({
    portfolioEquity: 100000,
    positionValue: 31000,
    entryAllocationCapPct: 25,
    hardExposureCapPct: 30,
  });
  assert.equal(breach.decision, 'REDUCE');
  assert.equal(breach.reasonCode, 'RISK_HARD_EXPOSURE_CAP');
  assert.equal(breach.targetPositionValue, 30000);
  assert.equal(breach.reduceNotional, 1000);
});
