export function calculatePerformance({ startingEquity, equityCurve, trades = [] }) {
  if (!Number.isFinite(startingEquity) || startingEquity <= 0) throw new Error('INVALID_STARTING_EQUITY');
  if (!Array.isArray(equityCurve) || equityCurve.length === 0 || equityCurve.some((v) => !Number.isFinite(v) || v < 0)) throw new Error('INVALID_EQUITY_CURVE');
  if (!Array.isArray(trades) || trades.some((t) => !Number.isFinite(t?.pnl))) throw new Error('INVALID_TRADES');

  const endingEquity = equityCurve.at(-1);
  const netReturnPct = ((endingEquity - startingEquity) / startingEquity) * 100;

  let peak = equityCurve[0];
  let maxDrawdownPct = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const wins = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const losses = trades.filter((t) => t.pnl < 0).map((t) => t.pnl);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0));
  const tradeCount = trades.length;
  const winRatePct = tradeCount > 0 ? (wins.length / tradeCount) * 100 : 0;
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : null;
  const expectancy = tradeCount > 0 ? trades.reduce((a, t) => a + t.pnl, 0) / tradeCount : 0;
  const averageWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const averageLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  return {
    startingEquity,
    endingEquity,
    netReturnPct,
    maxDrawdownPct,
    tradeCount,
    winRatePct,
    profitFactor,
    expectancy,
    averageWin,
    averageLoss,
    grossProfit,
    grossLoss: -grossLossAbs,
  };
}
