const REQUIRED=[
  'pnl','entry1dDistanceAboveEma200Pct','entry4hEmaSpreadPct',
  'entry4hTrendAgeBars','entry4hTransitionCount12',
];

function metrics(rows) {
  const count=rows.length;
  if (!count) return {count:0,pnl:0,winRatePct:null,profitFactor:null,expectancy:null};
  const pnl=rows.reduce((s,r)=>s+r.pnl,0);
  const wins=rows.filter(r=>r.pnl>0);
  const losses=rows.filter(r=>r.pnl<=0);
  const grossProfit=wins.reduce((s,r)=>s+r.pnl,0);
  const grossLoss=Math.abs(losses.reduce((s,r)=>s+r.pnl,0));
  return {
    count,
    pnl,
    winRatePct:wins.length/count*100,
    profitFactor:grossLoss===0?null:grossProfit/grossLoss,
    expectancy:pnl/count,
  };
}

function group(rows, selector, labels) {
  const out={};
  for (const label of labels) out[label]=metrics(rows.filter(r=>selector(r)===label));
  return out;
}

export function summarizeStructuralBuckets(trades) {
  if (!Array.isArray(trades)) throw new Error('INVALID_TRADES');
  for (const trade of trades) {
    if (REQUIRED.some(key=>!Number.isFinite(trade?.[key]))) throw new Error('INVALID_STRUCTURAL_TRADE');
  }

  return {
    boundaries:{
      dailyDistanceAboveEma200Pct:[25,50],
      h4EmaSpreadPct:[1,3],
      h4TrendAgeBars:[6,24],
      h4TransitionCount12:[0,2],
    },
    dailyDistanceAboveEma200Pct:group(
      trades,
      r=>r.entry1dDistanceAboveEma200Pct<=25?'LE_25':(r.entry1dDistanceAboveEma200Pct<=50?'GT_25_LE_50':'GT_50'),
      ['LE_25','GT_25_LE_50','GT_50'],
    ),
    h4EmaSpreadPct:group(
      trades,
      r=>r.entry4hEmaSpreadPct<=1?'LE_1':(r.entry4hEmaSpreadPct<=3?'GT_1_LE_3':'GT_3'),
      ['LE_1','GT_1_LE_3','GT_3'],
    ),
    h4TrendAgeBars:group(
      trades,
      r=>r.entry4hTrendAgeBars<=6?'LE_6':(r.entry4hTrendAgeBars<=24?'GT_6_LE_24':'GT_24'),
      ['LE_6','GT_6_LE_24','GT_24'],
    ),
    h4TransitionCount12:group(
      trades,
      r=>r.entry4hTransitionCount12===0?'ZERO':(r.entry4hTransitionCount12<=2?'ONE_TO_TWO':'GT_2'),
      ['ZERO','ONE_TO_TWO','GT_2'],
    ),
  };
}
