import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchBinanceSpotKlines } from '../algo/binance-kline-fetcher.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';

function arg(name, fallback=null) {
  const i=process.argv.indexOf(`--${name}`);
  return i>=0 ? process.argv[i+1] : fallback;
}

const symbol=arg('symbol');
const start=arg('start','2023-01-01T00:00:00Z');
const end=arg('end','2026-08-25T23:00:00Z');
const out=arg('out',null);
const venue=arg('venue','BINANCE_PUBLIC_MARKET_DATA');
if (!symbol) throw new Error('MISSING_SYMBOL');
const startTime=Date.parse(start), endTime=Date.parse(end);
if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) throw new Error('INVALID_DATE_RANGE');

const parameters={
  startingEquity:Number(arg('equity','100000')),
  riskPct:Number(arg('risk-pct','0.0035')),
  maxPositionPct:Number(arg('max-position-pct','0.25')),
  atrStopMult:Number(arg('atr-stop-mult','1.5')),
  trailAtrMult:Number(arg('trail-atr-mult','2.0')),
  spreadBps:Number(arg('spread-bps','2')),
  slippageBps:Number(arg('slippage-bps','2')),
  feeBps:Number(arg('fee-bps','10')),
  maxSpreadBps:Number(arg('max-spread-bps','10')),
  maxSlippageBps:Number(arg('max-slippage-bps','10')),
  pullbackLookback:Number(arg('pullback-lookback','20')),
};
for (const [k,v] of Object.entries(parameters)) if (!Number.isFinite(v)) throw new Error(`INVALID_PARAMETER:${k}`);

const candles=await fetchBinanceSpotKlines({symbol,startTime,endTime,interval:'1h'});
const result=runTrendPullbackBacktest({candles,...parameters});
const riskCounts={};
for (const e of result.riskEvents ?? []) riskCounts[e.reasonCode]=(riskCounts[e.reasonCode]??0)+1;
const summary={
  purpose:'CROSS_VALIDATION_ONLY_NOT_BYBIT_FINAL_GATE',
  engine:'ALGO_V2_TREND_PULLBACK_V1_2_MTF',
  venue,
  symbol,
  requestedRange:{start:new Date(startTime).toISOString(),end:new Date(endTime).toISOString()},
  data:{candles:candles.length,first:candles[0]?.time??null,last:candles.at(-1)?.time??null},
  parameters,
  status:result.status,
  metrics:result.metrics??null,
  totalExecutionCosts:result.totalExecutionCosts??0,
  maxObservedExposurePct:result.maxObservedExposurePct??0,
  riskDecisionCounts:riskCounts,
  openPosition:Boolean(result.openPosition),
  generatedAt:new Date().toISOString(),
};
const text=JSON.stringify(summary,null,2);
if (out) {
  await fs.mkdir(path.dirname(out),{recursive:true});
  await fs.writeFile(out,text+'\n','utf8');
}
console.log(text);
if (result.status!=='COMPLETED') process.exitCode=2;
