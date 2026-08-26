import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCompletedCandles } from '../algo/mtf-aggregation.mjs';
import { estimateMarketFill } from '../algo/execution-costs.mjs';

function h(time, open, high, low, close, volume=1) {
  return { time: new Date(time).toISOString(), open, high, low, close, volume };
}

test('aggregates four completed 1H candles into one UTC-aligned 4H candle', () => {
  const rows = [
    h('2026-01-01T00:00:00Z', 100, 103, 99, 102, 10),
    h('2026-01-01T01:00:00Z', 102, 104, 101, 103, 20),
    h('2026-01-01T02:00:00Z', 103, 105, 100, 101, 30),
    h('2026-01-01T03:00:00Z', 101, 106, 100, 105, 40),
  ];
  const out = aggregateCompletedCandles(rows, { timeframeHours: 4 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    time: '2026-01-01T00:00:00.000Z',
    open: 100, high: 106, low: 99, close: 105, volume: 100,
  });
});

test('drops an incomplete final higher-timeframe bucket', () => {
  const rows = [
    h('2026-01-01T00:00:00Z', 1,1,1,1),
    h('2026-01-01T01:00:00Z', 1,1,1,1),
    h('2026-01-01T02:00:00Z', 1,1,1,1),
  ];
  assert.equal(aggregateCompletedCandles(rows, { timeframeHours: 4 }).length, 0);
});

test('asOf excludes a 4H candle until its final 1H candle has completed', () => {
  const rows = [0,1,2,3].map(i => h(`2026-01-01T0${i}:00:00Z`, 1,2,0,1));
  assert.equal(aggregateCompletedCandles(rows, { timeframeHours: 4, asOf: '2026-01-01T03:59:59Z' }).length, 0);
  assert.equal(aggregateCompletedCandles(rows, { timeframeHours: 4, asOf: '2026-01-01T04:00:00Z' }).length, 1);
});

test('rejects gaps inside a would-be completed bucket', () => {
  const rows = [
    h('2026-01-01T00:00:00Z', 1,1,1,1),
    h('2026-01-01T01:00:00Z', 1,1,1,1),
    h('2026-01-01T03:00:00Z', 1,1,1,1),
    h('2026-01-01T04:00:00Z', 1,1,1,1),
  ];
  assert.throws(() => aggregateCompletedCandles(rows, { timeframeHours: 4 }), /NON_CONTIGUOUS_1H_DATA/);
});

test('market buy includes half-spread, slippage and fee', () => {
  const fill = estimateMarketFill({ side: 'BUY', referencePrice: 100, qty: 2, spreadBps: 10, slippageBps: 5, feeBps: 10 });
  assert.ok(Math.abs(fill.price - 100.1) < 1e-12);
  assert.ok(Math.abs(fill.notional - 200.2) < 1e-12);
  assert.ok(Math.abs(fill.fee - 0.2002) < 1e-12);
  assert.ok(Math.abs(fill.cashDelta + 200.4002) < 1e-12);
});

test('market sell applies costs in the adverse direction', () => {
  const fill = estimateMarketFill({ side: 'SELL', referencePrice: 100, qty: 2, spreadBps: 10, slippageBps: 5, feeBps: 10 });
  assert.ok(Math.abs(fill.price - 99.9) < 1e-12);
  assert.ok(Math.abs(fill.cashDelta - (199.8 - 0.1998)) < 1e-12);
});
