import fs from 'node:fs/promises';
import { parseBybitMt4Klines15m } from '../algo/bybit-mt4-kline-importer.mjs';
import { splitContiguousHourlySegments, selectEligibleHourlySegments } from '../algo/hourly-segments.mjs';
import { runTrendPullbackBacktest } from '../algo/trend-pullback-backtest.mjs';
import { estimateMarketFill } from '../algo/execution-costs.mjs';

function arg(name, fallback=null) {
  const i=process.argv.indexOf(`--${name}`);
  return i>=0 ? process.argv[i+1] : fallback;
}

const input=arg('input');
const out=arg('out');
const minHours=Number(arg('min-hours','4800'));
if (!input) throw new Error('MISSING_INPUT');

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

const text=await fs.readFile(input,'utf8');
const candles=parseBybitMt4Klines15m(text);
const allSegments=splitContiguousHourlySegments(candles);
const eligible=selectEligibleHourlySegments(allSegments,{minHours});
const diagnostics=[];

for (const segment of eligible) {
  const segmentIndex=allSegments.indexOf(segment);
  const result=runTrendPullbackBacktest({candles:segment,...parameters});
  const byTime=new Map(segment.map((c,i)=>[c.time,{...c,index:i}]));
  let cash=parameters.startingEquity;
  let max=null;
  const tradeDiagnostics=[];

  for (let tradeIndex=0; tradeIndex<result.trades.length; tradeIndex++) {
    const trade=result.trades[tradeIndex];
    const entry=byTime.get(trade.entryTime);
    const exit=byTime.get(trade.exitTime);
    if (!entry || !exit) throw new Error('TRADE_TIME_NOT_IN_SEGMENT');

    const buy=estimateMarketFill({side:'BUY',referencePrice:entry.close,qty:trade.qty,spreadBps:parameters.spreadBps,slippageBps:parameters.slippageBps,feeBps:parameters.feeBps});
    cash += buy.cashDelta;
    let tradeMax=null;

    for (let i=entry.index;i<=exit.index;i++) {
      const c=segment[i];
      const positionValue=trade.qty*c.close;
      const equity=cash+positionValue;
      const exposurePct=equity>0 ? positionValue/equity*100 : Infinity;
      const observation={tradeIndex,time:c.time,close:c.close,entryTime:trade.entryTime,exitTime:trade.exitTime,qty:trade.qty,cash,equity,positionValue,exposurePct};
      if (!tradeMax || exposurePct>tradeMax.exposurePct) tradeMax=observation;
      if (!max || exposurePct>max.exposurePct) max=observation;
    }

    const sell=estimateMarketFill({side:'SELL',referencePrice:exit.close,qty:trade.qty,spreadBps:parameters.spreadBps,slippageBps:parameters.slippageBps,feeBps:parameters.feeBps});
    cash += sell.cashDelta;
    tradeDiagnostics.push({tradeIndex,entryTime:trade.entryTime,exitTime:trade.exitTime,pnl:trade.pnl,maxExposure:tradeMax});
  }

  diagnostics.push({
    segmentIndex,
    first:segment[0].time,
    last:segment.at(-1).time,
    tradeCount:result.trades.length,
    backtestMaxObservedExposurePct:result.maxObservedExposurePct,
    replayMaxExposure:max,
    endingCashReplay:cash,
    endingEquityBacktest:result.endingEquity,
    tradeDiagnostics,
  });
}

const summary={
  engine:'ALGO_V2_EXPOSURE_DIAGNOSTIC_V1',
  parameters,
  eligibleSegmentCount:eligible.length,
  diagnostics,
};
const json=JSON.stringify(summary,null,2);
if (out) await fs.writeFile(out,json+'\n','utf8');
console.log(json);
