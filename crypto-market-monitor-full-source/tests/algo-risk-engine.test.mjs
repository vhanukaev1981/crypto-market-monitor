import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRisk } from '../algo/risk-engine.mjs';

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
