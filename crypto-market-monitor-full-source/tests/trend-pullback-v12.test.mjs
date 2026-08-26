import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrendPullback } from '../algo/trend-pullback.mjs';

function base(overrides={}) {
  return {
    regime:'TREND_UP', regimeConfidence:85, structural1d:'TREND_UP', confirmation4h:'TREND_UP', dataHealth:'GREEN', riskHealth:'GREEN',
    price:100, ema20:100.2, ema50:99, ema200:90, ema20Slope:0.5, ema50Slope:0.2, adx14:30, atr:2,
    rsi14:55, pullbackDepthPct:2, previousClose:101, candleHigh:102, candleLow:99, candleClose:99.5,
    volume:90, volume20Avg:100, spreadBps:2, maxSpreadBps:10, estimatedSlippageBps:2, maxSlippageBps:10,
    stopDistancePct:6,
    ...overrides,
  };
}

test('V1.2 does not reject a valid setup only because ATR stop exceeds 4%', () => {
  const r = evaluateTrendPullback(base());
  assert.equal(r.action, 'BUY_CANDIDATE');
});

test('V1.2 treats weak stabilization as a score reduction rather than hard rejection', () => {
  const weak = evaluateTrendPullback(base({ stopDistancePct:3 }));
  const strong = evaluateTrendPullback(base({ stopDistancePct:3, candleClose:101.5, previousClose:100 }));
  assert.equal(weak.action, 'BUY_CANDIDATE');
  assert.ok(weak.score < strong.score);
  assert.ok(weak.riskMultiplier <= strong.riskMultiplier);
});

test('4H TREND_DOWN still blocks entries', () => {
  const r = evaluateTrendPullback(base({ confirmation4h:'TREND_DOWN', stopDistancePct:3 }));
  assert.equal(r.action, 'NO_TRADE');
  assert.equal(r.reason, 'TREND_CONFIRMATION_FAILED');
});

test('V1.2 keeps volume as a hard gate', () => {
  const r = evaluateTrendPullback(base({ volume:50, volume20Avg:100, stopDistancePct:3 }));
  assert.equal(r.action, 'NO_TRADE');
  assert.equal(r.reason, 'VOLUME_FILTER_FAILED');
});
