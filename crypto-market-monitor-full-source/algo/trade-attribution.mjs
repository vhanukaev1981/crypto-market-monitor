function validateTrade(trade) {
  const time=Date.parse(trade?.entryTime);
  if (!Number.isFinite(time) || !Number.isFinite(trade?.pnl) || typeof trade?.entryRegime!=='string' || trade.entryRegime.length===0 || typeof trade?.exitReason!=='string' || trade.exitReason.length===0) {
    throw new Error('INVALID_ATTRIBUTION_TRADE');
  }
}

function averageFinite(rows, key) {
  const values=rows.map(r=>r[key]).filter(Number.isFinite);
  return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
}

function summarizeBucket(rows) {
  const wins=rows.filter(r=>r.pnl>0);
  const losses=rows.filter(r=>r.pnl<0);
  const grossProfit=wins.reduce((s,r)=>s+r.pnl,0);
  const grossLoss=losses.reduce((s,r)=>s+r.pnl,0);
  const totalPnl=rows.reduce((s,r)=>s+r.pnl,0);
  return {
    tradeCount:rows.length,
    winCount:wins.length,
    lossCount:losses.length,
    totalPnl,
    expectancy:rows.length ? totalPnl/rows.length : null,
    winRatePct:rows.length ? wins.length/rows.length*100 : null,
    grossProfit,
    grossLoss,
    profitFactor:grossLoss<0 ? grossProfit/Math.abs(grossLoss) : null,
    averageWin:wins.length ? grossProfit/wins.length : null,
    averageLoss:losses.length ? grossLoss/losses.length : null,
    averageEntryScore:averageFinite(rows,'entryScore'),
    averageEntryRegimeConfidence:averageFinite(rows,'entryRegimeConfidence'),
    averageEntryAtrPct:averageFinite(rows,'entryAtrPct'),
    averageEntryAdx14:averageFinite(rows,'entryAdx14'),
    averageEntryRsi14:averageFinite(rows,'entryRsi14'),
  };
}

function grouped(rows,keyFn) {
  const groups=new Map();
  for (const row of rows) {
    const key=keyFn(row);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].sort(([a],[b])=>String(a).localeCompare(String(b))).map(([key,bucket])=>[key,summarizeBucket(bucket)]));
}

export function summarizeTradeAttribution(trades) {
  if (!Array.isArray(trades)) throw new Error('INVALID_ATTRIBUTION_TRADES');
  for (const trade of trades) validateTrade(trade);
  const year=t=>String(new Date(t.entryTime).getUTCFullYear());
  return {
    total:summarizeBucket(trades),
    byYear:grouped(trades,year),
    byRegime:grouped(trades,t=>t.entryRegime),
    byYearRegime:grouped(trades,t=>`${year(t)}|${t.entryRegime}`),
    byExitReason:grouped(trades,t=>t.exitReason),
  };
}
