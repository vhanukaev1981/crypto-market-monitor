import fs from 'node:fs/promises';
import { parseBybitMt4Klines15m } from '../algo/bybit-mt4-kline-importer.mjs';
import { findHourlyGaps, splitContiguousHourlySegments, selectEligibleHourlySegments } from '../algo/hourly-segments.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';
import { summarizeTradeAttribution } from '../algo/trade-attribution.mjs';

function arg(name, fallback=null) {
  const i=process.argv.indexOf(`--${name}`);
  return i>=0 ? process.argv[i+1] : fallback;
}

const symbol=arg('symbol');
const input=arg('input');
const out=arg('out');
const minHours=Number(arg('min-hours','4800'));
if (!symbol || !input) throw new Error('MISSING_REQUIRED_ARGUMENT');
if (!Number.isInteger(minHours) || minHours<1) throw new Error('INVALID_MIN_HOURS');

const parameters={
  startingEquity:100000,
  riskPct:0.0035,
  maxPositionPct:0.25,
  hardExposurePct:0.30,
  atrStopMult:1.5,
  trailAtrMult:2.0,
  spreadBps:2,
  slippageBps:2,
  feeBps:10,
  maxSpreadBps:10,
  maxSlippageBps:10,
};

const text=await fs.readFile(input,'utf8');
const candles=parseBybitMt4Klines15m(text);
for (const candle of candles) {
  const t=Date.parse(candle.time);
  if (!Number.isFinite(t) || t%3600000!==0) throw new Error('MISALIGNED_MT4_60M_TIMESTAMP');
}

const gaps=findHourlyGaps(candles);
const allSegments=splitContiguousHourlySegments(candles);
const eligible=selectEligibleHourlySegments(allSegments,{minHours});
const segmentAnalyses=[];

for (const segment of eligible) {
  const segmentIndex=allSegments.indexOf(segment);
  const result=runTrendPullbackBacktest({candles:segment,...parameters});
  if (result.status!=='COMPLETED') throw new Error(`SEGMENT_BACKTEST_${result.status}`);
  const attribution=summarizeTradeAttribution(result.trades);
  segmentAnalyses.push({
    segmentIndex,
    hours:segment.length,
    first:segment[0].time,
    last:segment.at(-1).time,
    endingEquity:result.endingEquity,
    netReturnPct:result.metrics.netReturnPct,
    maxDrawdownPct:result.metrics.maxDrawdownPct,
    tradeCount:result.trades.length,
    totalExecutionCosts:result.totalExecutionCosts,
    rawMaxExposurePct:result.maxObservedExposurePct,
    postControlMaxExposurePct:result.maxPostControlExposurePct,
    hardExposureTrimCount:result.exposureControlEvents.length,
    attribution,
    trades:result.trades,
  });
}

const summary={
  engine:'ALGO_V2_BYBIT_TRADE_ATTRIBUTION_V1_2',
  symbol,
  parameters:{
    ...parameters,
    entryAllocationCapPct:parameters.maxPositionPct*100,
    hardExposureCapPct:parameters.hardExposurePct*100,
  },
  data:{
    sourceCandles:candles.length,
    first:candles[0]?.time??null,
    last:candles.at(-1)?.time??null,
    gapCount:gaps.length,
    gaps,
    segmentCount:allSegments.length,
    eligibleSegmentCount:eligible.length,
    minHours,
  },
  segmentAnalyses,
};

const json=JSON.stringify(summary,null,2);
if (out) await fs.writeFile(out,json+'\n','utf8');
console.log(json);
if (!segmentAnalyses.length) process.exitCode=2;
