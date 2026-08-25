export function markPortfolio({ cash, positions = {}, marks = {}, peakEquity = 0 }) {
  if (!Number.isFinite(cash)) throw new Error('INVALID_CASH');
  if (!Number.isFinite(peakEquity) || peakEquity < 0) throw new Error('INVALID_PEAK_EQUITY');

  const markedPositions = {};
  let marketValueTotal = 0;
  let unrealizedPnlTotal = 0;

  for (const [symbol, position] of Object.entries(positions)) {
    const qty = Number(position?.qty ?? 0);
    const totalCost = Number(position?.totalCost ?? 0);
    if (!Number.isFinite(qty) || qty < 0 || !Number.isFinite(totalCost) || totalCost < 0) {
      throw new Error('INVALID_POSITION');
    }
    if (qty === 0) {
      markedPositions[symbol] = { qty: 0, totalCost: 0, marketValue: 0, unrealizedPnl: 0, markPrice: null };
      continue;
    }
    const bid = Number(marks[symbol]?.bid);
    if (!Number.isFinite(bid) || bid <= 0) throw new Error(`MISSING_MARK:${symbol}`);
    const marketValue = qty * bid;
    const unrealizedPnl = marketValue - totalCost;
    marketValueTotal += marketValue;
    unrealizedPnlTotal += unrealizedPnl;
    markedPositions[symbol] = { qty, totalCost, markPrice: bid, marketValue, unrealizedPnl };
  }

  const equity = cash + marketValueTotal;
  const nextPeakEquity = Math.max(peakEquity, equity);
  const drawdownPct = nextPeakEquity > 0 ? ((nextPeakEquity - equity) / nextPeakEquity) * 100 : 0;

  return {
    cash,
    positions: markedPositions,
    marketValue: marketValueTotal,
    unrealizedPnl: unrealizedPnlTotal,
    equity,
    peakEquity: nextPeakEquity,
    drawdownPct,
  };
}

export function reconcilePortfolio({ marked, ledgerEquity, tolerance = 1e-9 }) {
  if (!marked || !Number.isFinite(marked.equity) || !Number.isFinite(ledgerEquity) || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('INVALID_RECONCILIATION_INPUT');
  }
  const difference = marked.equity - ledgerEquity;
  const ok = Math.abs(difference) <= tolerance;
  return ok
    ? { ok: true, difference, reasonCode: 'PNL_OK' }
    : { ok: false, difference, reasonCode: 'PNL_001_EQUITY_MISMATCH' };
}
