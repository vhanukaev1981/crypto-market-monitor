import { aggregateCompletedCandles } from './mtf-aggregation.mjs';
import { emaSeries, smaSeries, atrSeries, rsiSeries, adxSeries } from './indicators.mjs';
import { detectRegime } from './regime-detector.mjs';
import { evaluateTrendPullback } from './trend-pullback.mjs';
import { evaluateRisk } from './risk-engine.mjs';
import { applyHardExposureTrim } from './exposure-trim.mjs';
import { estimateMarketFill } from './execution-costs.mjs';
import { calculatePerformance } from './backtest-metrics.mjs';

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) throw new Error('INVALID_CANDLES');
  return candles.map(c=>({time:new Date(c.time).toISOString(),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume)}));
}

function entryMetadata(position) {
  return {
    entryRegime: position.entryRegime,
    entryRegimeConfidence: position.entryRegimeConfidence,
    structural1d: position.structural1d,
    confirmation4h: position.confirmation4h,
    entryAtrPct: position.entryAtrPct,
    entryAdx14: position.entryAdx14,
    entryRsi14: position.entryRsi14,
  };
}

export function runTrendPullbackBacktest({
  candles,
  startingEquity=100000,
  riskPct=0.0035,
  maxPositionPct=0.25,
  hardExposurePct=0.30,
  atrStopMult=1.5,
  trailAtrMult=2.0,
  spreadBps=2,
  slippageBps=2,
  feeBps=10,
  maxSpreadBps=10,
  maxSlippageBps=10,
  pullbackLookback=20,
}={}) {
  if (!Number.isFinite(maxPositionPct) || maxPositionPct<=0 || !Number.isFinite(hardExposurePct) || hardExposurePct<=maxPositionPct) throw new Error('INVALID_EXPOSURE_LIMITS');
  const rows=normalizeCandles(candles);
  if (rows.length < 4800) return {status:'INSUFFICIENT_HISTORY', trades:[], equityCurve:[], startingEquity, endingEquity:startingEquity, maxObservedExposurePct:0, maxPostControlExposurePct:0, exposureControlEvents:[]};
  const h4=aggregateCompletedCandles(rows,{timeframeHours:4});
  const d1=aggregateCompletedCandles(rows,{timeframeHours:24});
  if (h4.length<200 || d1.length<200) return {status:'INSUFFICIENT_HISTORY', trades:[], equityCurve:[], startingEquity, endingEquity:startingEquity, maxObservedExposurePct:0, maxPostControlExposurePct:0, exposureControlEvents:[]};

  const closes=rows.map(c=>c.close);
  const ema20=emaSeries(closes,20), ema50=emaSeries(closes,50), ema200=emaSeries(closes,200);
  const atr=atrSeries(rows,14), rsi=rsiSeries(closes,14), adx=adxSeries(rows,14), vol20=smaSeries(rows.map(c=>c.volume),20);
  const h4Close=h4.map(c=>c.close), h4e20=emaSeries(h4Close,20), h4e50=emaSeries(h4Close,50);
  const d1Close=d1.map(c=>c.close), d1e200=emaSeries(d1Close,200);
  const h4Features=h4.map((c,i)=>({endMs:Date.parse(c.time)+4*3600000,close:c.close,e20:h4e20[i],e50:h4e50[i]}));
  const d1Features=d1.map((c,i)=>({endMs:Date.parse(c.time)+24*3600000,close:c.close,e200:d1e200[i]}));
  let h4p=-1,d1p=-1;

  let cash=startingEquity, position=null, peak=startingEquity, dayStartEquity=startingEquity, currentDay=null;
  let maxObservedExposurePct=0, maxPostControlExposurePct=0, totalExecutionCosts=0;
  const trades=[], equityCurve=[], riskEvents=[], exposureControlEvents=[];

  for (let i=0;i<rows.length;i++) {
    const c=rows[i], decisionMs=Date.parse(c.time)+3600000;
    while (h4p+1<h4Features.length && h4Features[h4p+1].endMs<=decisionMs) h4p++;
    while (d1p+1<d1Features.length && d1Features[d1p+1].endMs<=decisionMs) d1p++;

    const markEquity=cash+(position?position.qty*c.close:0);
    const dayKey=c.time.slice(0,10);
    if (currentDay===null) currentDay=dayKey;
    if (dayKey!==currentDay) { dayStartEquity=markEquity; currentDay=dayKey; }
    peak=Math.max(peak,markEquity);
    const drawdownPct=peak>0?((peak-markEquity)/peak)*100:0;
    const dailyPnlPct=dayStartEquity>0?((markEquity-dayStartEquity)/dayStartEquity)*100:0;
    if (position) maxObservedExposurePct=Math.max(maxObservedExposurePct,(position.qty*c.close/markEquity)*100);

    if (i<200 || h4p<49 || d1p<199 || [ema20[i],ema50[i],ema200[i],atr[i],rsi[i],adx[i],vol20[i]].some(v=>v==null)) {
      if (position) maxPostControlExposurePct=Math.max(maxPostControlExposurePct,(position.qty*c.close/markEquity)*100);
      equityCurve.push(markEquity); continue;
    }

    if (position) {
      const trim=applyHardExposureTrim({
        time:c.time,
        cash,
        position,
        referencePrice:c.close,
        entryAllocationCapPct:maxPositionPct*100,
        hardExposureCapPct:hardExposurePct*100,
        spreadBps,
        slippageBps,
        feeBps,
      });
      cash=trim.cash;
      position=trim.position;
      if (trim.action==='REDUCE') {
        totalExecutionCosts+=trim.executionCost;
        trades.push(trim.trade);
        exposureControlEvents.push(trim.event);
      }
      maxPostControlExposurePct=Math.max(maxPostControlExposurePct,trim.postExposurePct);

      position.trailingStop=Math.max(position.trailingStop,c.close-trailAtrMult*atr[i]);
      const exitReason=c.close<ema50[i]?'TREND_INVALIDATION':(c.close<=position.trailingStop?'TRAILING_STOP':null);
      if (exitReason) {
        const fill=estimateMarketFill({side:'SELL',referencePrice:c.close,qty:position.qty,spreadBps,slippageBps,feeBps});
        totalExecutionCosts += position.qty * (c.close - fill.price) + fill.fee;
        cash += fill.cashDelta;
        const pnl=fill.cashDelta-position.totalCost;
        trades.push({entryTime:position.entryTime,exitTime:c.time,entryPrice:position.entryPrice,exitPrice:fill.price,qty:position.qty,pnl,exitReason,entryScore:position.entryScore,...entryMetadata(position)});
        position=null;
      }
      equityCurve.push(cash+(position?position.qty*c.close:0));
      continue;
    }

    const hf=h4Features[h4p], df=d1Features[d1p];
    if (hf.e20==null || hf.e50==null || df.e200==null) { equityCurve.push(cash); continue; }
    const confirmation4h=(hf.close>hf.e50 && hf.e20>hf.e50)?'TREND_UP':((hf.close<hf.e50 && hf.e20<hf.e50)?'TREND_DOWN':'NEUTRAL');
    const structural1d=df.close>df.e200?'TREND_UP':'TREND_DOWN';
    const atrPct=atr[i]/c.close*100;
    const regime=detectRegime({price:c.close,ema20:ema20[i],ema50:ema50[i],ema200:ema200[i],ema20Slope:ema20[i]-ema20[i-1],ema50Slope:ema50[i]-ema50[i-1],adx14:adx[i],atrPct});
    const lookbackStart=Math.max(0,i-pullbackLookback+1);
    const recentHigh=Math.max(...rows.slice(lookbackStart,i+1).map(x=>x.high));
    const pullbackDepthPct=((recentHigh-c.close)/recentHigh)*100;
    const signal=evaluateTrendPullback({
      regime:regime.regime, regimeConfidence:regime.confidence, structural1d, confirmation4h, dataHealth:'GREEN', riskHealth:'GREEN',
      price:c.close, ema20:ema20[i], ema50:ema50[i], ema200:ema200[i], ema20Slope:ema20[i]-ema20[i-1], ema50Slope:ema50[i]-ema50[i-1], adx14:adx[i], atr:atr[i], rsi14:rsi[i], pullbackDepthPct,
      previousClose:rows[i-1].close,candleHigh:c.high,candleLow:c.low,candleClose:c.close,volume:c.volume,volume20Avg:vol20[i],spreadBps,maxSpreadBps,estimatedSlippageBps:slippageBps,maxSlippageBps,
    });
    if (signal.action!=='BUY_CANDIDATE') { equityCurve.push(cash); continue; }

    const stopDistance=atrStopMult*atr[i];
    const riskBudget=markEquity*riskPct*signal.riskMultiplier;
    const riskQty=riskBudget/stopDistance;
    const unitFill=estimateMarketFill({side:'BUY',referencePrice:c.close,qty:1,spreadBps,slippageBps,feeBps});
    const unitDebit=-unitFill.cashDelta;
    const frictionPerUnit=unitDebit-c.close;
    const capQty=(maxPositionPct*cash)/(c.close + maxPositionPct*frictionPerUnit);
    const cashQty=(cash*0.995)/unitDebit;
    const requestedQty=Math.max(0,Math.min(riskQty,capQty,cashQty));
    const requestedNotional=requestedQty*c.close;
    const volLevel=atrPct>=5?'extreme':atrPct>=3?'high':atrPct>=2?'elevated':'normal';
    const risk=evaluateRisk({portfolioEquity:markEquity,dailyPnlPct,drawdownPct,volatilityLevel:volLevel,currentSymbolExposurePct:0,maxSymbolExposurePct:maxPositionPct*100,requestedNotional,spreadBps,maxSpreadBps,estimatedSlippageBps:slippageBps,maxSlippageBps});
    riskEvents.push({time:c.time,...risk});
    if (!['APPROVED','REDUCED_SIZE'].includes(risk.decision) || risk.approvedNotional<=0) { equityCurve.push(cash); continue; }
    let qty=Math.min(risk.approvedNotional/c.close, capQty, cashQty);
    let fill=estimateMarketFill({side:'BUY',referencePrice:c.close,qty,spreadBps,slippageBps,feeBps});
    if (-fill.cashDelta>cash) {
      qty=(cash*0.999)/(fill.price*(1+feeBps/10000));
      fill=estimateMarketFill({side:'BUY',referencePrice:c.close,qty,spreadBps,slippageBps,feeBps});
    }
    if (qty<=0) { equityCurve.push(cash); continue; }
    totalExecutionCosts += qty * (fill.price - c.close) + fill.fee;
    cash += fill.cashDelta;
    position={
      qty,
      totalCost:-fill.cashDelta,
      entryTime:c.time,
      entryPrice:fill.price,
      initialStop:fill.price-stopDistance,
      trailingStop:fill.price-stopDistance,
      entryScore:signal.score,
      entryRegime:regime.regime,
      entryRegimeConfidence:regime.confidence,
      structural1d,
      confirmation4h,
      entryAtrPct:atrPct,
      entryAdx14:adx[i],
      entryRsi14:rsi[i],
    };
    const eqAfter=cash+position.qty*c.close;
    const entryExposurePct=(position.qty*c.close/eqAfter)*100;
    maxObservedExposurePct=Math.max(maxObservedExposurePct,entryExposurePct);
    maxPostControlExposurePct=Math.max(maxPostControlExposurePct,entryExposurePct);
    equityCurve.push(eqAfter);
  }
  const endingEquity=equityCurve.at(-1)??startingEquity;
  const metrics=calculatePerformance({startingEquity,equityCurve,trades});
  return {status:'COMPLETED',startingEquity,endingEquity,trades,equityCurve,metrics,maxObservedExposurePct,maxPostControlExposurePct,totalExecutionCosts,riskEvents,exposureControlEvents,openPosition:position};
}
