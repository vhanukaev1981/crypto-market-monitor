import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { tradesStreamToHourlyCandles } from '../algo/bybit-trade-stream-import.mjs';
import { monthKeys, mergeHourlyCandleChunks, spotArchiveUrl } from '../algo/bybit-spot-archive.mjs';
import { validateStrictHourlyCandles } from '../algo/hourly-data-quality.mjs';
import { spotResearchTimeRange, spotArchiveCoverageTimeRange } from '../algo/spot-research-window.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';
import { annotateTradesWithStructuralPersistence } from '../algo/structural-trade-annotation.mjs';
import { summarizeTradeAttribution } from '../algo/trade-attribution.mjs';
import { summarizeRiskDecisions } from '../algo/risk-decision-attribution.mjs';
import { summarizeSignalFunnel } from '../algo/signal-funnel.mjs';
import { summarizeTradeFeatureOutcomes } from '../algo/trade-feature-outcomes.mjs';
import { summarizeStructuralBuckets } from '../algo/structural-bucket-attribution.mjs';

function arg(name,fallback=null){
  const i=process.argv.indexOf(`--${name}`);
  return i>=0?process.argv[i+1]:fallback;
}

const symbol=arg('symbol','BTCUSDT');
const startMonth=arg('start-month','2022-11');
const endMonth=arg('end-month','2024-12');
const out=arg('out');
const maxCompressedGb=Number(arg('max-compressed-gb','20'));
if(!/^[A-Z0-9]{3,20}$/.test(symbol)) throw new Error('INVALID_SYMBOL');
if(!Number.isFinite(maxCompressedGb)||maxCompressedGb<=0) throw new Error('INVALID_DOWNLOAD_CAP');

const requestedRange=spotResearchTimeRange({startMonth,endMonth});
const archiveRange=spotArchiveCoverageTimeRange({startMonth,endMonth});
const maxCompressedBytes=maxCompressedGb*1024**3;

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

// Frozen before candidate replay. 25% is the ex-ante structural bucket boundary;
// 20% and 30% are sensitivity-only neighbors and must not be selected after results.
const researchCandidate={
  name:'DAILY_EMA200_OVEREXTENSION',
  status:'UNFROZEN_RESEARCH_CANDIDATE',
  thresholdPct:25,
  sensitivityThresholdsPct:[20,25,30],
  rationale:'Avoid long entries after the completed 1D trend is materially overextended above EMA200.',
  usesCompletedHigherTimeframeOnly:true,
  tuningAfterReplay:false,
  blindOosOpened:false,
};

const months=monthKeys(startMonth,endMonth);
const manifest=[];
let knownCompressedBytes=0;
for(const month of months){
  const url=spotArchiveUrl({symbol,month});
  const head=await fetch(url,{method:'HEAD',redirect:'follow'});
  if(!head.ok) throw new Error(`SPOT_ARCHIVE_HEAD_FAILED:${month}:${head.status}`);
  const len=Number(head.headers.get('content-length'));
  if(!Number.isFinite(len)||len<=0) throw new Error(`SPOT_ARCHIVE_CONTENT_LENGTH_REQUIRED:${month}`);
  knownCompressedBytes+=len;
  if(knownCompressedBytes>maxCompressedBytes) throw new Error(`SPOT_ARCHIVE_TOO_LARGE:${knownCompressedBytes}`);
  manifest.push({month,url,contentLength:len});
}

const chunks=[];
for(const item of manifest){
  const res=await fetch(item.url,{redirect:'follow'});
  if(!res.ok||!res.body) throw new Error(`SPOT_ARCHIVE_DOWNLOAD_FAILED:${item.month}:${res.status}`);
  const nodeBody=Readable.fromWeb(res.body);
  const gunzip=createGunzip();
  nodeBody.pipe(gunzip);
  const hourly=await tradesStreamToHourlyCandles(gunzip,{symbol,allowImplicitSymbol:true});
  if(hourly.length<24*20) throw new Error(`SPOT_ARCHIVE_MONTH_TOO_SPARSE:${item.month}:${hourly.length}`);
  chunks.push(hourly);
  console.error(`${item.month}: ${hourly.length} hourly candles`);
}

const merged=mergeHourlyCandleChunks(chunks);
const validated=validateStrictHourlyCandles(merged,{
  expectedStartTime:archiveRange.expectedFirst,
  expectedEndTime:archiveRange.expectedLast,
});
if(validated.metadata.candleCount!==archiveRange.expectedCandleCount) {
  throw new Error(`UNEXPECTED_HOURLY_CANDLE_COUNT:${validated.metadata.candleCount}:${archiveRange.expectedCandleCount}`);
}
const candles=validated.candles;
if(candles.length<4800) throw new Error(`SPOT_INSUFFICIENT_HISTORY:${candles.length}`);

const firstMs=Date.parse(candles[0].time);
const warmupMs=firstMs+4800*3600000;
const researchStart=Math.max(Date.UTC(2023,0,1),warmupMs);
const foldDefs=[
  {label:'2023_RESEARCH',startMs:researchStart,endMs:Date.UTC(2024,0,1)-3600000},
  {label:'2024_VALIDATION',startMs:Date.UTC(2024,0,1),endMs:Date.UTC(2025,0,1)-3600000},
];

function runFold(def,{thresholdPct=null,detailed=true}={}){
  const foldCandles=candles.filter(c=>Date.parse(c.time)<=def.endMs);
  if(!foldCandles.length || def.startMs>Date.parse(foldCandles.at(-1).time)) return null;
  const gateArgs=thresholdPct===null?{}:{researchMaxDailyDistanceAboveEma200Pct:thresholdPct};
  const result=runTrendPullbackBacktest({
    candles:foldCandles,
    tradingStartTime:new Date(def.startMs).toISOString(),
    ...parameters,
    ...gateArgs,
  });
  if(result.status!=='COMPLETED') throw new Error(`${def.label}_${result.status}`);
  if(result.exposureControlEvents.length>0) throw new Error(`${def.label}_PARTIAL_TRIM_REPORTING_REQUIRES_POSITION_LEVEL_METRICS`);
  const report={
    label:def.label,
    tradingStartTime:new Date(def.startMs).toISOString(),
    dataEnd:new Date(def.endMs).toISOString(),
    candleCount:foldCandles.length,
    endingEquity:result.endingEquity,
    netReturnPct:result.metrics.netReturnPct,
    maxDrawdownPct:result.metrics.maxDrawdownPct,
    profitFactor:result.metrics.profitFactor,
    expectancy:result.metrics.expectancy,
    winRatePct:result.metrics.winRatePct,
    tradeCount:result.trades.length,
    tradeCountSemantics:'COMPLETED_POSITION_EXITS',
    openPositionAtFoldEnd:Boolean(result.openPosition),
    totalExecutionCosts:result.totalExecutionCosts,
    maxObservedExposurePct:result.maxObservedExposurePct,
    maxPostControlExposurePct:result.maxPostControlExposurePct,
    researchFilterBlockedCount:result.researchFilterEvents.length,
  };
  if(!detailed) return report;
  const annotated=annotateTradesWithStructuralPersistence({candles:foldCandles,trades:result.trades});
  const attribution=summarizeTradeAttribution(result.trades);
  return {
    ...report,
    attribution,
    exitReasonAttribution:attribution.byExitReason,
    signalFunnel:summarizeSignalFunnel(result.signalFunnelEvents),
    risk:summarizeRiskDecisions(result.riskEvents),
    featureOutcomes:summarizeTradeFeatureOutcomes(annotated),
    structuralBuckets:summarizeStructuralBuckets(annotated),
  };
}

const folds=foldDefs.map(def=>runFold(def)).filter(Boolean);
const candidateFolds=foldDefs.map(def=>runFold(def,{thresholdPct:researchCandidate.thresholdPct})).filter(Boolean);
const sensitivity=researchCandidate.sensitivityThresholdsPct.map(thresholdPct=>({
  thresholdPct,
  folds: thresholdPct===researchCandidate.thresholdPct
    ? candidateFolds.map(({attribution,exitReasonAttribution,signalFunnel,risk,featureOutcomes,structuralBuckets,...compact})=>compact)
    : foldDefs.map(def=>runFold(def,{thresholdPct,detailed:false})).filter(Boolean),
}));

if(folds.length<2) throw new Error(`BASELINE_FOLDS_INCOMPLETE:${folds.length}`);
if(candidateFolds.length<2) throw new Error(`CANDIDATE_FOLDS_INCOMPLETE:${candidateFolds.length}`);
for(const item of sensitivity) if(item.folds.length<2) throw new Error(`SENSITIVITY_FOLDS_INCOMPLETE:${item.thresholdPct}:${item.folds.length}`);

const summary={
  engine:'ALGO_V2_BYBIT_SPOT_RESEARCH_V1_2',
  sourceMarket:'BYBIT_SPOT',
  source:'BYBIT_PUBLIC_SPOT_TRADE_ARCHIVES',
  provenance:'BYBIT_SPOT',
  conversion:'TRADE_STREAM_TO_OHLCV_1H',
  category:'spot',
  interval:'1h',
  symbol,
  startMonth,
  endMonth,
  oosLocked:true,
  oosWindow:'2025-01 onward',
  parameters,
  acquisition:{
    archiveBase:'https://public.bybit.com/spot',
    monthCount:months.length,
    maxCompressedGb,
    knownCompressedBytes,
    syntheticRepair:false,
    conflictingDuplicatePolicy:'FAIL_CLOSED',
    implicitSymbolPolicy:'PINNED_CANONICAL_ARCHIVE_URL_ONLY',
    preArchiveGapPolicy:'DOCUMENT_AND_EXCLUDE_FROM_WARMUP',
    manifest,
  },
  data:{
    ...validated.metadata,
    requestedWindow:{
      expectedFirst:requestedRange.expectedFirst,
      expectedLast:requestedRange.expectedLast,
      expectedCandleCount:requestedRange.expectedCandleCount,
    },
    archiveCoverage:{
      expectedFirst:archiveRange.expectedFirst,
      expectedLast:archiveRange.expectedLast,
      expectedCandleCount:archiveRange.expectedCandleCount,
      preArchiveMissingHours:archiveRange.preArchiveMissingHours,
    },
    warmupHoursRequired:4800,
    firstEligibleResearchEntry:new Date(researchStart).toISOString(),
  },
  folds,
  researchCandidate:{
    ...researchCandidate,
    folds:candidateFolds,
    sensitivity,
  },
};
const json=JSON.stringify(summary,null,2);
if(out){
  await fs.mkdir(dirname(out),{recursive:true});
  await fs.writeFile(out,json+'\n','utf8');
}
console.log(json);
