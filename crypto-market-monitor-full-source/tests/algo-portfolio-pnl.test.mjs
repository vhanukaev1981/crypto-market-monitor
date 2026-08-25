import test from 'node:test';
import assert from 'node:assert/strict';
import { markPortfolio, reconcilePortfolio } from '../algo/portfolio-pnl.mjs';

const approx = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);

test('marks open position conservatively at bid and computes unrealized pnl', () => {
  const result = markPortfolio({
    cash: 800,
    positions: { ETHUSDT: { qty: 2, totalCost: 180 } },
    marks: { ETHUSDT: { bid: 100, ask: 101 } },
    peakEquity: 1000,
  });
  approx(result.positions.ETHUSDT.marketValue, 200);
  approx(result.positions.ETHUSDT.unrealizedPnl, 20);
  approx(result.equity, 1000);
});

test('computes drawdown from peak equity', () => {
  const result = markPortfolio({
    cash: 700,
    positions: { BTCUSDT: { qty: 1, totalCost: 250 } },
    marks: { BTCUSDT: { bid: 200, ask: 201 } },
    peakEquity: 1000,
  });
  approx(result.equity, 900);
  approx(result.drawdownPct, 10);
  approx(result.peakEquity, 1000);
});

test('raises peak equity when a new high is reached', () => {
  const result = markPortfolio({ cash: 1050, positions: {}, marks: {}, peakEquity: 1000 });
  approx(result.equity, 1050);
  approx(result.peakEquity, 1050);
  approx(result.drawdownPct, 0);
});

test('fails closed when a mark is missing for an open position', () => {
  assert.throws(() => markPortfolio({
    cash: 900,
    positions: { ETHUSDT: { qty: 1, totalCost: 100 } },
    marks: {},
    peakEquity: 1000,
  }), /MISSING_MARK/);
});

test('reconciliation detects equity mismatch beyond tolerance', () => {
  const marked = markPortfolio({
    cash: 900,
    positions: { ETHUSDT: { qty: 1, totalCost: 90 } },
    marks: { ETHUSDT: { bid: 100, ask: 101 } },
    peakEquity: 1000,
  });
  const ok = reconcilePortfolio({ marked, ledgerEquity: 1000, tolerance: 1e-9 });
  assert.equal(ok.ok, true);
  const bad = reconcilePortfolio({ marked, ledgerEquity: 999, tolerance: 0.01 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonCode, 'PNL_001_EQUITY_MISMATCH');
});
