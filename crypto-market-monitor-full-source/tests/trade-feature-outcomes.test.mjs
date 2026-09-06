import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTradeFeatureOutcomes } from '../algo/trade-feature-outcomes.mjs';

const trades=[
  {pnl:100,entryAtrPct:0.6,entryAdx14:30,entryRsi14:55,entryPullbackDepthPct:1.0,entryEma20SlopePct:0.10,entryEma50SlopePct:0.05,entryDistanceToEma20Atr:0.2,entryDistanceToEma50Atr:0.4,entryEfficiency24:0.70,entryEfficiency72:0.55,entryEma20PositiveSlopeShare24:0.83,entryAdxDelta12:3,entry4hTrendAgeBars:8,entry4hTransitionCount12:1,entry4hEmaSpreadPct:1.4,entry1dDistanceAboveEma200Pct:12,holdingHours:30},
  {pnl:-50,entryAtrPct:1.4,entryAdx14:35,entryRsi14:57,entryPullbackDepthPct:2.0,entryEma20SlopePct:0.04,entryEma50SlopePct:0.02,entryDistanceToEma20Atr:0.7,entryDistanceToEma50Atr:1.1,entryEfficiency24:0.20,entryEfficiency72:0.18,entryEma20PositiveSlopeShare24:0.54,entryAdxDelta12:-4,entry4hTrendAgeBars:2,entry4hTransitionCount12:4,entry4hEmaSpreadPct:0.3,entry1dDistanceAboveEma200Pct:3,holdingHours:10},
  {pnl:200,entryAtrPct:0.8,entryAdx14:28,entryRsi14:53,entryPullbackDepthPct:1.2,entryEma20SlopePct:0.12,entryEma50SlopePct:0.06,entryDistanceToEma20Atr:0.1,entryDistanceToEma50Atr:0.3,entryEfficiency24:0.80,entryEfficiency72:0.62,entryEma20PositiveSlopeShare24:0.92,entryAdxDelta12:5,entry4hTrendAgeBars:12,entry4hTransitionCount12:0,entry4hEmaSpreadPct:1.8,entry1dDistanceAboveEma200Pct:18,holdingHours:40},
];

test('summarizes ex-ante trade features for all winners and losers',()=>{
  const s=summarizeTradeFeatureOutcomes(trades);
  assert.equal(s.all.count,3);
  assert.equal(s.winners.count,2);
  assert.equal(s.losers.count,1);
  assert.equal(s.all.features.entryAtrPct.median,0.8);
  assert.equal(s.winners.features.holdingHours.mean,35);
  assert.equal(s.losers.features.entryAtrPct.mean,1.4);
  assert.ok(Number.isFinite(s.all.features.entryEma20SlopePct.p25));
  assert.ok(Number.isFinite(s.all.features.entryDistanceToEma50Atr.p75));
  assert.equal(s.losers.features.entryEfficiency24.mean,0.20);
  assert.equal(s.winners.features.entryEma20PositiveSlopeShare24.mean,0.875);
  assert.ok(Number.isFinite(s.all.features.entryEfficiency72.median));
  assert.ok(Number.isFinite(s.all.features.entryAdxDelta12.p25));
  assert.equal(s.losers.features.entry4hTrendAgeBars.mean,2);
  assert.equal(s.winners.features.entry4hTransitionCount12.mean,0.5);
  assert.equal(s.all.features.entry4hEmaSpreadPct.median,1.4);
  assert.equal(s.winners.features.entry1dDistanceAboveEma200Pct.mean,15);
});

test('rejects missing or non-finite required feature values',()=>{
  assert.throws(()=>summarizeTradeFeatureOutcomes([{...trades[0],entry4hTrendAgeBars:NaN}]),/INVALID_TRADE_FEATURE/);
});
