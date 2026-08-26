import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTradeAttribution } from '../algo/trade-attribution.mjs';

function nearlyEqual(actual,expected,tolerance=1e-12) {
  assert.ok(Math.abs(actual-expected)<=tolerance,`expected ${actual} ≈ ${expected}`);
}

const trades=[
  {entryTime:'2020-06-01T00:00:00.000Z',pnl:100,entryRegime:'TREND_UP',entryRegimeConfidence:85,entryScore:80,entryAtrPct:2,entryAdx14:30,entryRsi14:55,exitReason:'TRAILING_STOP'},
  {entryTime:'2020-07-01T00:00:00.000Z',pnl:-50,entryRegime:'TREND_UP',entryRegimeConfidence:70,entryScore:70,entryAtrPct:3,entryAdx14:20,entryRsi14:45,exitReason:'TREND_INVALIDATION'},
  {entryTime:'2021-02-01T00:00:00.000Z',pnl:-25,entryRegime:'TREND_UP',entryRegimeConfidence:75,entryScore:75,entryAtrPct:4,entryAdx14:25,entryRsi14:50,exitReason:'TREND_INVALIDATION'},
];

test('summarizes realized trades by year regime and year-regime with auditable metrics', () => {
  const r=summarizeTradeAttribution(trades);
  assert.equal(r.total.tradeCount,3);
  assert.equal(r.total.totalPnl,25);
  nearlyEqual(r.total.winRatePct,100/3);
  nearlyEqual(r.total.profitFactor,100/75);
  nearlyEqual(r.total.expectancy,25/3);

  assert.equal(r.byYear['2020'].tradeCount,2);
  assert.equal(r.byYear['2020'].totalPnl,50);
  assert.equal(r.byYear['2020'].profitFactor,2);
  assert.equal(r.byYear['2020'].averageEntryScore,75);
  assert.equal(r.byYear['2020'].averageEntryAtrPct,2.5);
  assert.equal(r.byYear['2020'].averageEntryAdx14,25);
  assert.equal(r.byYear['2020'].averageEntryRsi14,50);

  assert.equal(r.byYear['2021'].totalPnl,-25);
  assert.equal(r.byRegime.TREND_UP.tradeCount,3);
  assert.equal(r.byYearRegime['2020|TREND_UP'].tradeCount,2);
});

test('rejects trade rows without finite pnl or entry attribution fields', () => {
  assert.throws(()=>summarizeTradeAttribution([{entryTime:'2020-01-01T00:00:00Z',pnl:NaN,entryRegime:'TREND_UP'}]),/INVALID_ATTRIBUTION_TRADE/);
  assert.throws(()=>summarizeTradeAttribution([{entryTime:'2020-01-01T00:00:00Z',pnl:1}]),/INVALID_ATTRIBUTION_TRADE/);
});
