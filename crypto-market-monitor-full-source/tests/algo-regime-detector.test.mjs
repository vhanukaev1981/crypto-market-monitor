import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRegime } from '../algo/regime-detector.mjs';

test('detects confirmed uptrend', () => {
  const result = detectRegime({
    price: 110,
    ema20: 108,
    ema50: 104,
    ema200: 100,
    ema20Slope: 0.8,
    ema50Slope: 0.3,
    adx14: 28,
    atrPct: 1.2,
    bollingerBandwidthPct: 4.5,
    volatilityPercentile: 60,
  });
  assert.equal(result.regime, 'TREND_UP');
  assert.ok(result.confidence >= 70);
});

test('high volatility overrides trend classification', () => {
  const result = detectRegime({
    price: 110,
    ema20: 108,
    ema50: 104,
    ema200: 100,
    ema20Slope: 0.8,
    ema50Slope: 0.3,
    adx14: 28,
    atrPct: 5.5,
    bollingerBandwidthPct: 10,
    volatilityPercentile: 97,
  });
  assert.equal(result.regime, 'HIGH_VOLATILITY');
});
