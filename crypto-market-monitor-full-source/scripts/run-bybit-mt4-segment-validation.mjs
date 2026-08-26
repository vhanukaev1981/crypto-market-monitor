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
if (!Number.isInteger(minHours) || minHours < 1) throw new Error('INVALID_MIN_HOURS');

const text=await fs.readFile(input,'utf8');
const candles=parseBybitMt4Klines15m(text);
for (const candle of candles) {
  const t=Date.parse(candle.time);
  if (!Number.isFinite(t) || t % 3600000 !== 0) throw new Error('MISALIGNED_MT4_60M_TIMESTAMP');
}

const gaps=findHourlyGaps(candles);
const allSegments=splitContiguousHourlySegments(candles);
const eligible=selectEligibleHourlySegments(allSegments,{minHours});

const parameters={
  startingEquity:100000,
  riskPct:0.0035,
  maxPositionPct:0.25,
  atrStopMult:1.5,
  trailAtrMult:2.0,
  spreadBps:2,
  slippageBps:2,
  feeBps:10,
  maxSpreadBps:10,
  maxSlippageBps:10,
};

const segmentMeta=allSegments.map((segment,index)=>({
  index,
  hours:segment.length,
  first:segment[0]?.time??null,
  last:segment.at(-1)?.time??null,
  eligible:segment.length>=minHours,
}));

const results=[];
for (const segment of eligible) {
  const originalIndex=allSegments.indexOf(segment);
  const result=runTrendPullbackBacktest({candles:segment,...parameters});
  results.push({
    segmentIndex:originalIndex,
    hours:segment.length,
    first:segment[0].time,
    last:segment.at(-1).time,
    status:result.status,
    metrics:result.metrics??null,
    tradeCount:result.trades?.length??0,
    totalExecutionCosts:result.totalExecutionCosts??0,
    maxObservedExposurePct:result.maxObservedExposurePct??0,
    openPosition:Boolean(result.openPosition),
  });
}

const summary={
  engine:'ALGO_V2_BYBIT_MT4_60M_SEGMENT_VALIDATION_V1_2',
  symbol,
  data:{
    sourceCandles:candles.length,
    first:candles[0]?.time??null,
    last:candles.at(-1)?.time??null,
    gapCount:gaps.length,
    gaps,
    segmentCount:allSegments.length,
    eligibleSegmentCount:eligible.length,
    minHours,
    segments:segmentMeta,
  },
  parameters,
  status:eligible.length>0 && results.every(r=>r.status==='COMPLETED') ? 'COMPLETED' : 'INSUFFICIENT_CONTIGUOUS_HISTORY',
  segmentResults:results,
};

const json=JSON.stringify(summary,null,2);
if (out) await fs.writeFile(out,json+'\n','utf8');
console.log(json);
if (summary.status!=='COMPLETED') process.exitCode=2;
