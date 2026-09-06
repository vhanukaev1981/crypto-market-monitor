import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrendPullback } from '../algo/trend-pullback.mjs';

test('approves a high-quality pullback setup', () => {
  const result = evaluateTrendPullback({
    regime: 'TREND_UP',
    regimeConfidence: 82,
    structural1d: 'NEUTRAL',
    confirmation4h: 'TREND_UP',
    dataHealth: 'GREEN',
    riskHealth: 'GREEN',
    price: 104,
    ema20: 103.5,
    ema50: 101.5,
    ema200: 95,
    ema20Slope: 0.4,
    ema50Slope: 0.2,
    adx14: 27,
    atr: 2,
    rsi14: 54,
    pullbackDepthPct: 1.8,
    previousClose: 103.2,
    candleHigh: 104.4,
    candleLow: 102.8,
    candleClose: 104,
    volume: 980,
    volume20Avg: 1000,
    spreadBps: 2,
    maxSpreadBps: 10,
    estimatedSlippageBps: 2,
    maxSlippageBps: 10,
    stopDistancePct: 2.2,
  });
  assert.equal(result.action, 'BUY_CANDIDATE');
  assert.ok(result.score >= 70);
});

test('rejects setup outside trend-up regime', () => {
  const result = evaluateTrendPullback({ regime: 'RANGE' });
  assert.equal(result.action, 'NO_TRADE');
  assert.equal(result.reason, 'REGIME_NOT_ALLOWED');
});

test('rejects chasing price too far above EMA20', () => {
  const result = evaluateTrendPullback({
    regime: 'TREND_UP', regimeConfidence: 90, structural1d: 'NEUTRAL', confirmation4h: 'TREND_UP',
    dataHealth: 'GREEN', riskHealth: 'GREEN', price: 110, ema20: 103, ema50: 100, ema200: 95,
    ema20Slope: 0.5, ema50Slope: 0.2, adx14: 30, atr: 2, rsi14: 60, pullbackDepthPct: 1,
    previousClose: 109, candleHigh: 111, candleLow: 108, candleClose: 110,
    volume: 1000, volume20Avg: 1000, spreadBps: 2, maxSpreadBps: 10,
    estimatedSlippageBps: 2, maxSlippageBps: 10, stopDistancePct: 2,
  });
  assert.equal(result.action, 'NO_TRADE');
  assert.equal(result.reason, 'NO_CHASE');
});
