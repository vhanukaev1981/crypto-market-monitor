import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePerformance } from '../algo/backtest-metrics.mjs';

const approx = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);

test('calculates net return and maximum drawdown from equity curve', () => {
  const result = calculatePerformance({
    startingEquity: 1000,
    equityCurve: [1000, 1100, 990, 1200, 1140],
    trades: [{ pnl: 100 }, { pnl: -110 }, { pnl: 210 }, { pnl: -60 }],
  });
  approx(result.netReturnPct, 14);
  approx(result.maxDrawdownPct, 10);
});

test('calculates win rate profit factor and expectancy', () => {
  const result = calculatePerformance({
    startingEquity: 1000,
    equityCurve: [1000, 1010],
    trades: [{ pnl: 20 }, { pnl: -10 }, { pnl: 30 }, { pnl: -30 }],
  });
  approx(result.winRatePct, 50);
  approx(result.profitFactor, 1.25);
  approx(result.expectancy, 2.5);
  approx(result.averageWin, 25);
  approx(result.averageLoss, -20);
});

test('returns null profit factor when there are no losing trades', () => {
  const result = calculatePerformance({
    startingEquity: 1000,
    equityCurve: [1000, 1030],
    trades: [{ pnl: 10 }, { pnl: 20 }],
  });
  assert.equal(result.profitFactor, null);
});

test('rejects invalid or empty equity curves', () => {
  assert.throws(() => calculatePerformance({ startingEquity: 1000, equityCurve: [], trades: [] }), /INVALID_EQUITY_CURVE/);
});
