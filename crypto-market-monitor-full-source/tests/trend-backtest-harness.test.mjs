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

test('completed trades preserve entry regime metadata for post-run attribution', () => {
  const r=runTrendPullbackBacktest({candles:makeTrend(7000),spreadBps:0,slippageBps:0,feeBps:0});
  assert.ok(r.trades.length>0);
  for (const trade of r.trades) {
    assert.equal(trade.entryRegime,'TREND_UP');
    assert.ok(Number.isFinite(trade.entryRegimeConfidence));
    assert.ok(trade.entryRegimeConfidence>=70 && trade.entryRegimeConfidence<=100);
    assert.equal(trade.structural1d,'TREND_UP');
    assert.equal(trade.confirmation4h,'TREND_UP');
    assert.ok(Number.isFinite(trade.entryAtrPct));
    assert.ok(Number.isFinite(trade.entryAdx14));
    assert.ok(Number.isFinite(trade.entryRsi14));
    assert.ok(Number.isFinite(trade.entryPullbackDepthPct));
    assert.ok(Number.isFinite(trade.entryEma20SlopePct));
    assert.ok(Number.isFinite(trade.entryEma50SlopePct));
    assert.ok(Number.isFinite(trade.entryDistanceToEma20Atr));
    assert.ok(Number.isFinite(trade.entryDistanceToEma50Atr));
    assert.ok(Number.isFinite(trade.entryEfficiency24));
    assert.ok(trade.entryEfficiency24>=0 && trade.entryEfficiency24<=1);
    assert.ok(Number.isFinite(trade.entryEfficiency72));
    assert.ok(trade.entryEfficiency72>=0 && trade.entryEfficiency72<=1);
    assert.ok(Number.isFinite(trade.entryEma20PositiveSlopeShare24));
    assert.ok(trade.entryEma20PositiveSlopeShare24>=0 && trade.entryEma20PositiveSlopeShare24<=1);
    assert.ok(Number.isFinite(trade.entryAdxDelta12));
    assert.ok(Number.isFinite(trade.holdingHours));
    assert.ok(trade.holdingHours>=0);
  }
});

test('harness records an auditable signal funnel event for every flat feature-ready evaluation', () => {
  const r=runTrendPullbackBacktest({candles:makeTrend(7000),spreadBps:0,slippageBps:0,feeBps:0});
  assert.ok(Array.isArray(r.signalFunnelEvents));
  assert.ok(r.signalFunnelEvents.length>0);
  for (const event of r.signalFunnelEvents.slice(0,25)) {
    assert.match(event.time,/^\d{4}-\d{2}-\d{2}T/);
    assert.ok(['NO_TRADE','BUY_CANDIDATE'].includes(event.action));
    assert.equal(typeof event.reason,'string');
    assert.equal(typeof event.regime,'string');
    assert.ok(Number.isFinite(event.regimeConfidence));
    assert.equal(typeof event.structural1d,'string');
    assert.equal(typeof event.confirmation4h,'string');
  }
});

test('risk events preserve the state that produced each decision', () => {
  const r=runTrendPullbackBacktest({candles:makeTrend(7000)});
  assert.ok(r.riskEvents.length>0);
  for (const event of r.riskEvents.slice(0,25)) {
    assert.ok(Number.isFinite(event.drawdownPct));
    assert.ok(Number.isFinite(event.dailyPnlPct));
    assert.ok(Number.isFinite(event.requestedNotional));
    assert.ok(Number.isFinite(event.atrPct));
    assert.equal(typeof event.volatilityLevel,'string');
    assert.equal(typeof event.signalReason,'string');
  }
});

test('research fold start keeps indicator warmup but forbids entries before the fold', () => {
  const candles=makeTrend(9000);
  const tradingStartTime=candles[6500].time;
  const r=runTrendPullbackBacktest({candles,tradingStartTime,spreadBps:0,slippageBps:0,feeBps:0});
  assert.equal(r.status,'COMPLETED');
  assert.equal(r.tradingStartTime,tradingStartTime);
  assert.ok(r.trades.length>0);
  for (const trade of r.trades) assert.ok(Date.parse(trade.entryTime)>=Date.parse(tradingStartTime));
  for (const event of r.riskEvents) assert.ok(Date.parse(event.time)>=Date.parse(tradingStartTime));
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
  const r=runTrendPullbackBacktest({candles:makeTrend(7000),maxPositionPct:0.25,hardExposurePct:0.30});
  assert.equal(r.status,'COMPLETED');
  assert.ok(Array.isArray(r.exposureControlEvents));
  assert.ok(Number.isFinite(r.maxPostControlExposurePct));
  assert.ok(r.maxPostControlExposurePct <= 30.000001);
});

test('harness fails closed when hard exposure cap is not above entry allocation cap', () => {
  assert.throws(() => runTrendPullbackBacktest({candles:makeTrend(7000),maxPositionPct:0.25,hardExposurePct:0.25}),/INVALID_EXPOSURE_LIMITS/);
});

test('research daily EMA200 overextension gate is opt-in and auditable without changing default V1.2 behavior', () => {
  const candles=makeTrend(7000);
  const baseline=runTrendPullbackBacktest({candles,spreadBps:0,slippageBps:0,feeBps:0});
  const gated=runTrendPullbackBacktest({candles,spreadBps:0,slippageBps:0,feeBps:0,researchMaxDailyDistanceAboveEma200Pct:0});
  assert.ok(baseline.trades.length>0);
  assert.equal(gated.trades.length,0);
  assert.deepEqual(baseline.researchFilterEvents,[]);
  assert.ok(gated.researchFilterEvents.length>0);
  for(const event of gated.researchFilterEvents.slice(0,10)){
    assert.equal(event.reason,'DAILY_EMA200_OVEREXTENSION');
    assert.ok(Number.isFinite(event.dailyDistanceAboveEma200Pct));
    assert.ok(event.dailyDistanceAboveEma200Pct>0);
    assert.equal(event.thresholdPct,0);
    assert.match(event.time,/^\d{4}-\d{2}-\d{2}T/);
  }
  assert.equal(gated.signalFunnelEvents.filter(e=>e.action==='BUY_CANDIDATE').length,baseline.signalFunnelEvents.filter(e=>e.action==='BUY_CANDIDATE').length);
});

test('research daily EMA200 overextension gate rejects invalid thresholds', () => {
  assert.throws(()=>runTrendPullbackBacktest({candles:makeTrend(7000),researchMaxDailyDistanceAboveEma200Pct:-0.01}),/INVALID_RESEARCH_DAILY_EMA200_DISTANCE_GATE/);
});
