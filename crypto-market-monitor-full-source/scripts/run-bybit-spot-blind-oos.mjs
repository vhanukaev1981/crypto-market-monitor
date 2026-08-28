import fs from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { tradesStreamToHourlyCandles } from '../algo/bybit-trade-stream-import.mjs';
import { mergeHourlyCandleChunks, spotArchiveUrl } from '../algo/bybit-spot-archive.mjs';
import { validateStrictHourlyCandles } from '../algo/hourly-data-quality.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';
import { FROZEN_ALGO_V2_PARAMETERS, readFrozenAlgoV2CandidateFreezeRecord } from '../algo/algo-v2-candidate-freeze.mjs';
import {
  BLIND_OOS_DIGEST_URL,
  BLIND_OOS_RECORD_URL,
  BLIND_OOS_START_MONTH,
  assertBlindOosCanOpen,
  assertNoCommittedBlindOosEvidence,
  assertFrozenBlindOosRecord,
  blindOosCoverageRange,
  expectedBlindOosContextMonths,
  resolveLatestAvailableClosedSpotArchiveMonth,
  sha256Hex,
} from '../algo/algo-v2-blind-oos.mjs';

const EXPOSURE_TOLERANCE_PCT=0.000001;

function arg(name,fallback=null){
  const i=process.argv.indexOf(`--${name}`);
  return i>=0?process.argv[i+1]:fallback;
}

const symbol=arg('symbol','BTCUSDT');
const out=arg('out',BLIND_OOS_RECORD_URL.pathname);
const digestOut=arg('digest-out',BLIND_OOS_DIGEST_URL.pathname);
const maxCompressedGb=Number(arg('max-compressed-gb','20'));
if(!/^[A-Z0-9]{3,20}$/.test(symbol)) throw new Error('INVALID_SYMBOL');
if(symbol!=='BTCUSDT') throw new Error('BLIND_OOS_SYMBOL_NOT_AUTHORIZED');
if(!Number.isFinite(maxCompressedGb)||maxCompressedGb<=0) throw new Error('INVALID_DOWNLOAD_CAP');

try{
  await fs.access(out);
  throw new Error('BLIND_OOS_ALREADY_EXECUTED');
}catch(error){
  if(error?.code!=='ENOENT') throw error;
}
try{
  await fs.access(digestOut);
  throw new Error('BLIND_OOS_ALREADY_EXECUTED');
}catch(error){
  if(error?.code!=='ENOENT') throw error;
}

const freezeRecord=await readFrozenAlgoV2CandidateFreezeRecord();
await assertNoCommittedBlindOosEvidence();
assertBlindOosCanOpen({freezeRecord,blindOosEvidenceExists:false});
const maxExposurePctThreshold=Number(String(freezeRecord.blindOosPassCriteria.maxExposurePct).replace(/[^0-9.]/g,''));
if(!Number.isFinite(maxExposurePctThreshold)) throw new Error('INVALID_BLIND_OOS_MAX_EXPOSURE_CRITERION');

const endMonth=await resolveLatestAvailableClosedSpotArchiveMonth({symbol});
const coverage=blindOosCoverageRange(endMonth);
const months=expectedBlindOosContextMonths(endMonth);
const maxCompressedBytes=maxCompressedGb*1024**3;

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
  expectedStartTime:coverage.expectedFirst,
  expectedEndTime:coverage.expectedLast,
});
if(validated.metadata.candleCount!==coverage.expectedCandleCount){
  throw new Error(`UNEXPECTED_HOURLY_CANDLE_COUNT:${validated.metadata.candleCount}:${coverage.expectedCandleCount}`);
}

const result=runTrendPullbackBacktest({
  candles:validated.candles,
  tradingStartTime:coverage.oosTradingStartTime,
  researchMaxDailyDistanceAboveEma200Pct:freezeRecord.freeze.thresholdPct,
  ...FROZEN_ALGO_V2_PARAMETERS,
});
if(result.status!=='COMPLETED') throw new Error(`BLIND_OOS_${result.status}`);
if(result.exposureControlEvents.length>0) throw new Error('BLIND_OOS_PARTIAL_TRIM_REPORTING_REQUIRES_POSITION_LEVEL_METRICS');

const metrics={
  netReturnPct:result.metrics.netReturnPct,
  maxDrawdownPct:result.metrics.maxDrawdownPct,
  profitFactor:result.metrics.profitFactor,
  expectancy:result.metrics.expectancy,
  winRatePct:result.metrics.winRatePct,
  completedTrades:result.trades.length,
  totalExecutionCosts:result.totalExecutionCosts,
  maxObservedExposurePct:result.maxObservedExposurePct,
  maxPostControlExposurePct:result.maxPostControlExposurePct,
  researchFilterBlockedCount:result.researchFilterEvents.length,
};

const checks={
  netReturnPct:metrics.netReturnPct>0,
  profitFactor:metrics.profitFactor>1,
  expectancy:metrics.expectancy>0,
  maxDrawdownPct:metrics.maxDrawdownPct<=5,
  maxExposurePct:metrics.maxObservedExposurePct<=maxExposurePctThreshold+EXPOSURE_TOLERANCE_PCT && metrics.maxPostControlExposurePct<=maxExposurePctThreshold+EXPOSURE_TOLERANCE_PCT,
  syntheticRepair:validated.metadata.syntheticCount===0,
  dataQualityViolations:validated.metadata.gapCount===0 && validated.metadata.syntheticCount===0,
  tuningAfterFreeze:freezeRecord.freeze.tuningAfterFreeze===false,
};
const passed=Object.values(checks).every(Boolean);

const record={
  schemaVersion:1,
  freezeEvidence:{
    path:'validation/algo-v2-candidate-freeze.json',
    head:freezeRecord.evidence.researchHead,
    workflowRunId:freezeRecord.evidence.workflowRunId,
    artifact:freezeRecord.evidence.artifact,
    candidateThresholdPct:freezeRecord.freeze.thresholdPct,
  },
  oos:{
    state:'OPENED_ONCE',
    startMonth:BLIND_OOS_START_MONTH,
    endMonth,
    tradingStartTime:coverage.oosTradingStartTime,
    openCount:1,
    blindOosOpened:true,
    tuningAfterFreeze:false,
    selectionReuseAllowed:false,
    tradingBehaviorChanged:false,
    promotionState:passed?'PAPER_TRADING_READINESS_AUDIT_AUTHORIZED':'FAIL_CLOSED_OOS',
  },
  provenance:{
    market:'BYBIT_SPOT',
    source:'BYBIT_PUBLIC_SPOT_TRADE_ARCHIVES',
    aggregation:'TRADE_STREAM_TO_OHLCV_1H',
    interval:'1h',
    contextStartMonth:freezeRecord.provenance.researchWindowStartMonth,
    researchWindowEndMonth:freezeRecord.provenance.researchWindowEndMonth,
    oosStartMonth:BLIND_OOS_START_MONTH,
    oosEndMonth:endMonth,
    archiveCoverageStart:validated.metadata.first,
    archiveCoverageEnd:validated.metadata.last,
    candleCount:validated.metadata.candleCount,
    gapCount:validated.metadata.gapCount,
    syntheticCandles:validated.metadata.syntheticCount,
    syntheticRepair:validated.metadata.syntheticCount>0,
    archiveBase:'https://public.bybit.com/spot',
    knownCompressedBytes,
    manifest,
  },
  parameters:FROZEN_ALGO_V2_PARAMETERS,
  metrics,
  passCriteria:freezeRecord.blindOosPassCriteria,
  evaluation:{
    passed,
    checks,
  },
};
const json=`${JSON.stringify(record,null,2)}\n`;
const digest=sha256Hex(json);
assertFrozenBlindOosRecord(record,{digest});
const digestLine=`${digest}  ${basename(out)}\n`;
await fs.mkdir(dirname(out),{recursive:true});
await fs.mkdir(dirname(digestOut),{recursive:true});
await fs.writeFile(out,json,'utf8');
await fs.writeFile(digestOut,digestLine,'utf8');
console.log(json);
