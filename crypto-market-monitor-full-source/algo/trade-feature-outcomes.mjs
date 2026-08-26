const FEATURES=[
  'entryAtrPct','entryAdx14','entryRsi14','entryPullbackDepthPct',
  'entryEma20SlopePct','entryEma50SlopePct','entryDistanceToEma20Atr',
  'entryDistanceToEma50Atr','entryEfficiency24','entryEfficiency72',
  'entryEma20PositiveSlopeShare24','entryAdxDelta12',
  'entry4hTrendAgeBars','entry4hTransitionCount12','entry4hEmaSpreadPct',
  'entry1dDistanceAboveEma200Pct','holdingHours',
];

function percentile(sorted,p){
  if (!sorted.length) return null;
  const idx=(sorted.length-1)*p;
  const lo=Math.floor(idx), hi=Math.ceil(idx);
  if (lo===hi) return sorted[lo];
  const w=idx-lo;
  return sorted[lo]*(1-w)+sorted[hi]*w;
}

function stats(values){
  if (!values.length) return {mean:null,median:null,p25:null,p75:null,min:null,max:null};
  const sorted=[...values].sort((a,b)=>a-b);
  return {
    mean:values.reduce((a,b)=>a+b,0)/values.length,
    median:percentile(sorted,0.5),
    p25:percentile(sorted,0.25),
    p75:percentile(sorted,0.75),
    min:sorted[0],
    max:sorted.at(-1),
  };
}

function summarizeGroup(rows){
  const features={};
  for (const key of FEATURES) features[key]=stats(rows.map(r=>r[key]));
  return {count:rows.length,features};
}

export function summarizeTradeFeatureOutcomes(trades){
  if (!Array.isArray(trades)) throw new Error('INVALID_TRADES');
  for (const trade of trades) {
    if (!Number.isFinite(trade?.pnl)) throw new Error('INVALID_TRADE_FEATURE:pnl');
    for (const key of FEATURES) if (!Number.isFinite(trade?.[key])) throw new Error(`INVALID_TRADE_FEATURE:${key}`);
  }
  const winners=trades.filter(t=>t.pnl>0);
  const losers=trades.filter(t=>t.pnl<=0);
  return {
    all:summarizeGroup(trades),
    winners:summarizeGroup(winners),
    losers:summarizeGroup(losers),
  };
}
