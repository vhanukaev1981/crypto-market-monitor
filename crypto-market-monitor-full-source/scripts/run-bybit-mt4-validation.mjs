import fs from 'node:fs/promises';
import { parseBybitMt4Klines15m, aggregate15mTo1h } from '../algo/bybit-mt4-kline-importer.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';

function arg(name, fallback=null) {
  const i=process.argv.indexOf(`--${name}`);
  return i>=0 ? process.argv[i+1] : fallback;
}

const symbol=arg('symbol');
const input=arg('input');
const out=arg('out');
if (!symbol || !input) throw new Error('MISSING_REQUIRED_ARGUMENT');
const text=await fs.readFile(input,'utf8');
const candles15m=parseBybitMt4Klines15m(text);
const candles=aggregate15mTo1h(candles15m);
const result=runTrendPullbackBacktest({
  candles,
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
});
const summary={
  engine:'ALGO_V2_BYBIT_MT4_ARCHIVE_V1_2',
  symbol,
  data:{candles15m:candles15m.length,candles1h:candles.length,first:candles[0]?.time??null,last:candles.at(-1)?.time??null},
  parameters:{startingEquity:100000,riskPct:0.0035,maxPositionPct:0.25,atrStopMult:1.5,trailAtrMult:2,spreadBps:2,slippageBps:2,feeBps:10},
  status:result.status,
  metrics:result.metrics??null,
  totalExecutionCosts:result.totalExecutionCosts??0,
  maxObservedExposurePct:result.maxObservedExposurePct??0,
  tradeCount:result.trades?.length??0,
  openPosition:Boolean(result.openPosition),
};
const json=JSON.stringify(summary,null,2);
if (out) await fs.writeFile(out,json+'\n','utf8');
console.log(json);
if (result.status!=='COMPLETED') process.exitCode=2;
