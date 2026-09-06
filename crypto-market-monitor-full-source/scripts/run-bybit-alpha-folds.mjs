import fs from 'node:fs/promises';
import { parseBybitMt4Klines15m } from '../algo/bybit-mt4-kline-importer.mjs';
import { findHourlyGaps, splitContiguousHourlySegments, selectEligibleHourlySegments } from '../algo/hourly-segments.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';
import { summarizeRiskDecisions } from '../algo/risk-decision-attribution.mjs';
import { summarizeTradeAttribution } from '../algo/trade-attribution.mjs';
import { summarizeTradeFeatureOutcomes } from '../algo/trade-feature-outcomes.mjs';
import { annotateTradesWithStructuralPersistence } from '../algo/structural-trade-annotation.mjs';
import { summarizeStructuralBuckets } from '../algo/structural-bucket-attribution.mjs';

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
const folds=[];

for (const segment of eligible) {
  const segmentIndex=allSegments.indexOf(segment);
  const firstMs=Date.parse(segment[0].time);
  const lastMs=Date.parse(segment.at(-1).time);
  const firstYear=new Date(firstMs).getUTCFullYear();
  const lastYear=new Date(lastMs).getUTCFullYear();

  const foldYears=[];
  for (let year=Math.max(firstYear+1,2021); year<=lastYear; year++) {
    const start=Date.UTC(year,0,1);
    if (start>=firstMs && start<=lastMs) foldYears.push(year);
  }
  if (!foldYears.length || firstYear===lastYear) foldYears.unshift(null);

  for (const year of foldYears) {
    const tradingStartTime=year===null ? segment[0].time : new Date(Date.UTC(year,0,1)).toISOString();
    const result=runTrendPullbackBacktest({candles:segment,tradingStartTime,...parameters});
    if (result.status!=='COMPLETED') throw new Error(`FOLD_BACKTEST_${result.status}`);
    const annotatedTrades=annotateTradesWithStructuralPersistence({candles:segment,trades:result.trades});
    const risk=summarizeRiskDecisions(result.riskEvents);
    const attribution=summarizeTradeAttribution(result.trades);
    const featureOutcomes=summarizeTradeFeatureOutcomes(annotatedTrades);
    const structuralBuckets=summarizeStructuralBuckets(annotatedTrades);
    const firstHalt=result.riskEvents.find(e=>e.reasonCode==='RISK_003_MAX_DRAWDOWN') ?? null;
    folds.push({
      segmentIndex,
      foldLabel:year===null ? `SEGMENT_START_${segment[0].time.slice(0,10)}` : String(year),
      tradingStartTime,
      segmentFirst:segment[0].time,
      segmentLast:segment.at(-1).time,
      endingEquity:result.endingEquity,
      netReturnPct:result.metrics.netReturnPct,
      maxDrawdownPct:result.metrics.maxDrawdownPct,
      profitFactor:result.metrics.profitFactor,
      expectancy:result.metrics.expectancy,
      winRatePct:result.metrics.winRatePct,
      tradeCount:result.trades.length,
      totalExecutionCosts:result.totalExecutionCosts,
      openPosition:result.openPosition ? {entryTime:result.openPosition.entryTime,entryPrice:result.openPosition.entryPrice,qty:result.openPosition.qty} : null,
      firstHalt:firstHalt ? {
        time:firstHalt.time,
        drawdownPct:firstHalt.drawdownPct,
        dailyPnlPct:firstHalt.dailyPnlPct,
        requestedNotional:firstHalt.requestedNotional,
        reasonCode:firstHalt.reasonCode,
      } : null,
      risk,
      attribution,
      featureOutcomes,
      structuralBuckets,
    });
  }
}

const summary={
  engine:'ALGO_V2_BYBIT_INDEPENDENT_RISK_RESET_ALPHA_FOLDS_V1_2',
  warning:'RESEARCH_DIAGNOSTIC_ONLY. Production max-drawdown halt is unchanged. Each fold starts with fresh portfolio/risk state while preserving pre-fold candles for indicators. Structural persistence and fixed buckets are annotated post-run and cannot affect trading decisions.',
  symbol,
  parameters,
  data:{
    sourceCandles:candles.length,
    first:candles[0]?.time??null,
    last:candles.at(-1)?.time??null,
    gapCount:gaps.length,
    gaps,
    eligibleSegmentCount:eligible.length,
    minHours,
  },
  folds,
};

const json=JSON.stringify(summary,null,2);
if (out) await fs.writeFile(out,json+'\n','utf8');
console.log(json);
if (!folds.length) process.exitCode=2;
