import fs from 'node:fs/promises';
import { parseBybitMt4Klines15m } from '../algo/bybit-mt4-kline-importer.mjs';
import { findHourlyGaps, splitContiguousHourlySegments, selectEligibleHourlySegments } from '../algo/hourly-segments.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';

function arg(name, fallback=null) {
  const i=process.argv.indexOf(`--${name}`);
  return i>=0 ? process.argv[i+1] : fallback;
}

const symbol=arg('symbol');
const input=arg('input');
const out=arg('out');
const minHours=Number(arg('min-hours','4800'));
if (!symbol || !input) throw new Error('MISSING_REQUIRED_ARGUMENT');

const text=await fs.readFile(input,'utf8');
const candles=parseBybitMt4Klines15m(text);
const gaps=findHourlyGaps(candles);
const allSegments=splitContiguousHourlySegments(candles);
const eligible=selectEligibleHourlySegments(allSegments,{minHours});
if (eligible.length===0) throw new Error('NO_ELIGIBLE_CONTIGUOUS_SEGMENT');

const common={
  startingEquity:100000,
  riskPct:0.0035,
  maxPositionPct:0.25,
  trailAtrMult:2.0,
  maxSpreadBps:20,
  maxSlippageBps:20,
};
const variants=[
  {id:'ATR_1_2',atrStopMult:1.2,feeBps:10,spreadBps:2,slippageBps:2},
  {id:'BASELINE_ATR_1_5',atrStopMult:1.5,feeBps:10,spreadBps:2,slippageBps:2},
  {id:'ATR_1_8',atrStopMult:1.8,feeBps:10,spreadBps:2,slippageBps:2},
  {id:'COST_STRESS',atrStopMult:1.5,feeBps:15,spreadBps:4,slippageBps:4},
];

const results=[];
for (const [eligibleIndex,segment] of eligible.entries()) {
  const segmentIndex=allSegments.indexOf(segment);
  for (const variant of variants) {
    const r=runTrendPullbackBacktest({candles:segment,...common,...variant});
    results.push({
      eligibleIndex,
      segmentIndex,
      first:segment[0].time,
      last:segment.at(-1).time,
      hours:segment.length,
      variant:variant.id,
      parameters:{atrStopMult:variant.atrStopMult,feeBps:variant.feeBps,spreadBps:variant.spreadBps,slippageBps:variant.slippageBps},
      status:r.status,
      metrics:r.metrics??null,
      tradeCount:r.trades?.length??0,
      totalExecutionCosts:r.totalExecutionCosts??0,
      maxObservedExposurePct:r.maxObservedExposurePct??0,
    });
  }
}

const baseline=results.filter(r=>r.variant==='BASELINE_ATR_1_5');
const allBaselinePositive=baseline.length>0 && baseline.every(r=>(r.metrics?.netReturnPct??-Infinity)>0 && (r.metrics?.profitFactor??0)>1);
const robustnessPositive=results.every(r=>(r.metrics?.netReturnPct??-Infinity)>0 && (r.metrics?.profitFactor??0)>1);
const baselineTrades=baseline.reduce((s,r)=>s+(r.tradeCount??0),0);

const summary={
  engine:'ALGO_V2_BYBIT_MT4_60M_ROBUSTNESS_V1_2',
  symbol,
  data:{sourceCandles:candles.length,gaps,segmentCount:allSegments.length,eligibleSegmentCount:eligible.length,minHours},
  variants,
  baselineTrades,
  allBaselinePositive,
  robustnessPositive,
  sampleGate100Trades:baselineTrades>=100,
  results,
};
const json=JSON.stringify(summary,null,2);
if (out) await fs.writeFile(out,json+'\n','utf8');
console.log(json);
