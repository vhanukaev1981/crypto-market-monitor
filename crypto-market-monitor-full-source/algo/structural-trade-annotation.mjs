import { aggregateCompletedCandles } from './mtf-aggregation.mjs';
import { emaSeries } from './indicators.mjs';
import { consecutiveTailCount, transitionCount, relativeSpreadPct } from './structural-persistence-features.mjs';

function latestCompletedIndex(features, decisionMs) {
  let lo=0, hi=features.length-1, answer=-1;
  while (lo<=hi) {
    const mid=(lo+hi)>>1;
    if (features[mid].endMs<=decisionMs) {
      answer=mid;
      lo=mid+1;
    } else {
      hi=mid-1;
    }
  }
  return answer;
}

function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length===0) throw new Error('INVALID_CANDLES');
  for (const candle of candles) {
    const t=Date.parse(candle?.time);
    if (!Number.isFinite(t) || ![candle?.open,candle?.high,candle?.low,candle?.close,candle?.volume].every(Number.isFinite)) {
      throw new Error('INVALID_CANDLE');
    }
  }
}

export function annotateTradesWithStructuralPersistence({candles,trades}={}) {
  validateCandles(candles);
  if (!Array.isArray(trades)) throw new Error('INVALID_TRADES');
  if (!trades.length) return [];

  const h4=aggregateCompletedCandles(candles,{timeframeHours:4});
  const d1=aggregateCompletedCandles(candles,{timeframeHours:24});
  const h4Close=h4.map(c=>c.close);
  const d1Close=d1.map(c=>c.close);
  const h4e20=emaSeries(h4Close,20);
  const h4e50=emaSeries(h4Close,50);
  const d1e200=emaSeries(d1Close,200);

  const h4Features=h4.map((c,i)=>({
    endMs:Date.parse(c.time)+4*3600000,
    close:c.close,
    e20:h4e20[i],
    e50:h4e50[i],
    state:(h4e20[i]!=null && h4e50[i]!=null)
      ? ((c.close>h4e50[i] && h4e20[i]>h4e50[i])?'TREND_UP':((c.close<h4e50[i] && h4e20[i]<h4e50[i])?'TREND_DOWN':'NEUTRAL'))
      : 'UNREADY',
  }));
  const d1Features=d1.map((c,i)=>({
    endMs:Date.parse(c.time)+24*3600000,
    close:c.close,
    e200:d1e200[i],
  }));

  return trades.map(trade=>{
    const entryMs=Date.parse(trade?.entryTime);
    if (!Number.isFinite(entryMs)) throw new Error('INVALID_TRADE_ENTRY_TIME');
    const decisionMs=entryMs+3600000;
    const h4p=latestCompletedIndex(h4Features,decisionMs);
    const d1p=latestCompletedIndex(d1Features,decisionMs);
    if (h4p<49 || d1p<199) throw new Error('INSUFFICIENT_STRUCTURAL_CONTEXT');

    const hf=h4Features[h4p];
    const df=d1Features[d1p];
    if (![hf.close,hf.e20,hf.e50,df.close,df.e200].every(Number.isFinite)) throw new Error('INVALID_STRUCTURAL_FEATURES');
    const states=h4Features.slice(0,h4p+1).map(x=>x.state);
    const entry4hTrendAgeBars=consecutiveTailCount(states,'TREND_UP');
    const entry4hTransitionCount12=transitionCount(states,12);
    const entry4hEmaSpreadPct=relativeSpreadPct(hf.e20,hf.e50,hf.close);
    const entry1dDistanceAboveEma200Pct=relativeSpreadPct(df.close,df.e200,df.e200);
    if (![entry4hTrendAgeBars,entry4hTransitionCount12,entry4hEmaSpreadPct,entry1dDistanceAboveEma200Pct].every(Number.isFinite)) {
      throw new Error('INVALID_STRUCTURAL_FEATURES');
    }

    return {
      ...trade,
      entry4hTrendAgeBars,
      entry4hTransitionCount12,
      entry4hEmaSpreadPct,
      entry1dDistanceAboveEma200Pct,
    };
  });
}
