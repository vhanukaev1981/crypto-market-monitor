import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { tradesStreamToHourlyCandles } from '../algo/bybit-trade-stream-import.mjs';
import { monthKeys, mergeHourlyCandleChunks } from '../algo/bybit-spot-archive.mjs';
import { assertSpotResearchWindow } from '../algo/spot-research-window.mjs';
import { findHourlyGaps } from '../algo/hourly-segments.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';
import { annotateTradesWithStructuralPersistence } from '../algo/structural-trade-annotation.mjs';
import { summarizeTradeAttribution } from '../algo/trade-attribution.mjs';
import { summarizeRiskDecisions } from '../algo/risk-decision-attribution.mjs';
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
assertSpotResearchWindow({startMonth,endMonth});

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

const months=monthKeys(startMonth,endMonth);
const base=`https://public.bybit.com/spot/${symbol}`;
const manifest=[];
let knownCompressedBytes=0;

for(const month of months){
  const url=`${base}/${symbol}-${month}.csv.gz`;
  const head=await fetch(url,{method:'HEAD',redirect:'follow'});
  if(!head.ok) throw new Error(`SPOT_ARCHIVE_HEAD_FAILED:${month}:${head.status}`);
  const len=Number(head.headers.get('content-length'));
  if(Number.isFinite(len)&&len>0) knownCompressedBytes+=len;
  manifest.push({month,url,contentLength:Number.isFinite(len)&&len>0?len:null});
}
if(knownCompressedBytes>maxCompressedGb*1024**3) throw new Error(`SPOT_ARCHIVE_TOO_LARGE:${knownCompressedBytes}`);

const chunks=[];
for(const item of manifest){
  const res=await fetch(item.url,{redirect:'follow'});
  if(!res.ok||!res.body) throw new Error(`SPOT_ARCHIVE_DOWNLOAD_FAILED:${item.month}:${res.status}`);
  const nodeBody=Readable.fromWeb(res.body);
  const gunzip=createGunzip();
  nodeBody.pipe(gunzip);
  const hourly=await tradesStreamToHourlyCandles(gunzip,{symbol});
  if(hourly.length<24*20) throw new Error(`SPOT_ARCHIVE_MONTH_TOO_SPARSE:${item.month}:${hourly.length}`);
  chunks.push(hourly);
  console.error(`${item.month}: ${hourly.length} hourly candles`);
}

const candles=mergeHourlyCandleChunks(chunks);
const gaps=findHourlyGaps(candles);
if(gaps.length) throw new Error(`SPOT_HOURLY_GAPS:${JSON.stringify(gaps.slice(0,20))}`);
if(candles.length<4800) throw new Error(`SPOT_INSUFFICIENT_HISTORY:${candles.length}`);

const firstMs=Date.parse(candles[0].time);
const warmupMs=firstMs+4800*3600000;
const researchStart=Math.max(Date.UTC(2023,0,1),warmupMs);
const foldDefs=[
  {label:'2023_RESEARCH',startMs:researchStart,endMs:Date.UTC(2024,0,1)-3600000},
  {label:'2024_VALIDATION',startMs:Date.UTC(2024,0,1),endMs:Date.UTC(2025,0,1)-3600000},
];

const folds=[];
for(const def of foldDefs){
  const foldCandles=candles.filter(c=>Date.parse(c.time)<=def.endMs);
  if(!foldCandles.length || def.startMs>Date.parse(foldCandles.at(-1).time)) continue;
  const result=runTrendPullbackBacktest({candles:foldCandles,tradingStartTime:new Date(def.startMs).toISOString(),...parameters});
  if(result.status!=='COMPLETED') throw new Error(`${def.label}_${result.status}`);
  const annotated=annotateTradesWithStructuralPersistence({candles:foldCandles,trades:result.trades});
  folds.push({
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
    totalExecutionCosts:result.totalExecutionCosts,
    maxObservedExposurePct:result.maxObservedExposurePct,
    maxPostControlExposurePct:result.maxPostControlExposurePct,
    attribution:summarizeTradeAttribution(result.trades),
    risk:summarizeRiskDecisions(result.riskEvents),
    featureOutcomes:summarizeTradeFeatureOutcomes(annotated),
    structuralBuckets:summarizeStructuralBuckets(annotated),
  });
}

const summary={
  engine:'ALGO_V2_BYBIT_SPOT_RESEARCH_V1_2',
  sourceMarket:'BYBIT_SPOT',
  source:'public.bybit.com/spot',
  symbol,
  startMonth,
  endMonth,
  oosLocked:true,
  oosWindow:'2025-01 onward',
  parameters,
  data:{
    candleCount:candles.length,
    first:candles[0]?.time??null,
    last:candles.at(-1)?.time??null,
    gapCount:gaps.length,
    knownCompressedBytes,
    manifest,
  },
  folds,
};
const json=JSON.stringify(summary,null,2);
if(out){
  await fs.mkdir(dirname(out),{recursive:true});
  await fs.writeFile(out,json+'\n','utf8');
}
console.log(json);
if(folds.length<2) process.exitCode=2;
