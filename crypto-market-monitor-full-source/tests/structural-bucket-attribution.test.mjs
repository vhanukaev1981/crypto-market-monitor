import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStructuralBuckets } from '../algo/structural-bucket-attribution.mjs';

const trades=[
  {pnl:100,entry1dDistanceAboveEma200Pct:10,entry4hEmaSpreadPct:0.5,entry4hTrendAgeBars:4,entry4hTransitionCount12:0},
  {pnl:-50,entry1dDistanceAboveEma200Pct:35,entry4hEmaSpreadPct:2,entry4hTrendAgeBars:12,entry4hTransitionCount12:2},
  {pnl:-150,entry1dDistanceAboveEma200Pct:80,entry4hEmaSpreadPct:4,entry4hTrendAgeBars:40,entry4hTransitionCount12:4},
  {pnl:200,entry1dDistanceAboveEma200Pct:20,entry4hEmaSpreadPct:0.8,entry4hTrendAgeBars:5,entry4hTransitionCount12:0},
];

test('uses fixed predeclared structural buckets with auditable performance metrics',()=>{
  const s=summarizeStructuralBuckets(trades);
  assert.deepEqual(s.boundaries.dailyDistanceAboveEma200Pct,[25,50]);
  assert.deepEqual(s.boundaries.h4EmaSpreadPct,[1,3]);
  assert.deepEqual(s.boundaries.h4TrendAgeBars,[6,24]);
  assert.deepEqual(s.boundaries.h4TransitionCount12,[0,2]);
  assert.equal(s.dailyDistanceAboveEma200Pct['LE_25'].count,2);
  assert.equal(s.dailyDistanceAboveEma200Pct['LE_25'].pnl,300);
  assert.equal(s.dailyDistanceAboveEma200Pct['GT_50'].count,1);
  assert.equal(s.dailyDistanceAboveEma200Pct['GT_50'].pnl,-150);
  assert.equal(s.h4TransitionCount12['ZERO'].winRatePct,100);
  assert.equal(s.h4TrendAgeBars['GT_24'].profitFactor,0);
});

test('fails closed on missing structural features',()=>{
  assert.throws(()=>summarizeStructuralBuckets([{...trades[0],entry4hEmaSpreadPct:NaN}]),/INVALID_STRUCTURAL_TRADE/);
});
