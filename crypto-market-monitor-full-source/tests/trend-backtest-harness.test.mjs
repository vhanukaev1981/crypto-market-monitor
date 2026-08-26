import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';

function makeTrend(n, { slope=0.015, wave=2.2, period=36 }={}) {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const out=[];
  for (let i=0;i<n;i++) {
    const center=100 + slope*i + Math.sin(i*2*Math.PI/period)*wave;
    const prev=i?out[i-1].close:center-0.2;
    const close=center;
    const open=prev;
    const high=Math.max(open,close)+0.7;
    const low=Math.min(open,close)-0.7;
    const volume=100 + 15*Math.sin(i*2*Math.PI/24);
    out.push({time:new Date(start+i*3600000).toISOString(),open,high,low,close,volume});
  }
  return out;
}

test('returns insufficient history before 200 daily candles are available', () => {
  const r=runTrendPullbackBacktest({candles:makeTrend(3000)});
  assert.equal(r.status,'INSUFFICIENT_HISTORY');
  assert.equal(r.trades.length,0);
});

test('runs the full MTF chain and produces trades on a persistent synthetic uptrend', () => {
  const r=runTrendPullbackBacktest({candles:makeTrend(7000), spreadBps:0, slippageBps:0, feeBps:0});
  assert.equal(r.status,'COMPLETED');
  assert.ok(r.trades.length > 0);
  assert.ok(r.equityCurve.length > 0);
});

test('execution friction is explicitly accumulated by the harness', () => {
  const candles=makeTrend(7000);
  const free=runTrendPullbackBacktest({candles, spreadBps:0, slippageBps:0, feeBps:0});
  const costly=runTrendPullbackBacktest({candles, spreadBps:4, slippageBps:3, feeBps:10});
  assert.equal(free.totalExecutionCosts, 0);
  assert.ok(costly.totalExecutionCosts > 0);
});

test('spot-only entry allocation never exceeds configured entry cap at ordinary risk sizing', () => {
  const r=runTrendPullbackBacktest({candles:makeTrend(7000), maxPositionPct:0.25});
  assert.ok(r.maxObservedExposurePct <= 25.000001);
});

test('harness exposes separate entry and emergency exposure semantics', () => {
  const r=runTrendPullbackBacktest({
    candles:makeTrend(7000),
    maxPositionPct:0.25,
    hardExposurePct:0.30,
  });
  assert.equal(r.status,'COMPLETED');
  assert.ok(Array.isArray(r.exposureControlEvents));
  assert.ok(Number.isFinite(r.maxPostControlExposurePct));
  assert.ok(r.maxPostControlExposurePct <= 30.000001);
});

test('harness fails closed when hard exposure cap is not above entry allocation cap', () => {
  assert.throws(
    () => runTrendPullbackBacktest({candles:makeTrend(7000),maxPositionPct:0.25,hardExposurePct:0.25}),
    /INVALID_EXPOSURE_LIMITS/,
  );
});
