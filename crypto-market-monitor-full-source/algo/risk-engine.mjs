export function evaluateRisk(input) {
  const {
    portfolioEquity,
    dailyPnlPct = 0,
    drawdownPct = 0,
    volatilityLevel = 'normal',
    currentSymbolExposurePct = 0,
    maxSymbolExposurePct = 40,
    requestedNotional = 0,
    spreadBps = 0,
    maxSpreadBps = Infinity,
    estimatedSlippageBps = 0,
    maxSlippageBps = Infinity,
  } = input;

  if (!Number.isFinite(portfolioEquity) || portfolioEquity <= 0) {
    return { decision: 'REJECTED', approvedNotional: 0, reasonCode: 'RISK_000_INVALID_EQUITY' };
  }

  if (drawdownPct > 5) {
    return { decision: 'HALT_SYSTEM', approvedNotional: 0, reasonCode: 'RISK_003_MAX_DRAWDOWN' };
  }

  if (dailyPnlPct <= -1.5) {
    return { decision: 'REJECTED', approvedNotional: 0, reasonCode: 'RISK_002_DAILY_LOSS' };
  }

  if (volatilityLevel === 'extreme') {
    return { decision: 'REJECTED', approvedNotional: 0, reasonCode: 'RISK_008_VOLATILITY_SHOCK' };
  }

  if (spreadBps > maxSpreadBps) {
    return { decision: 'REJECTED', approvedNotional: 0, reasonCode: 'RISK_004_SPREAD_TOO_WIDE' };
  }

  if (estimatedSlippageBps > maxSlippageBps) {
    return { decision: 'REJECTED', approvedNotional: 0, reasonCode: 'RISK_005_SLIPPAGE' };
  }

  const availableExposurePct = Math.max(0, maxSymbolExposurePct - currentSymbolExposurePct);
  const availableNotional = portfolioEquity * (availableExposurePct / 100);

  const volatilityMultiplier = volatilityLevel === 'high' ? 0.5 : volatilityLevel === 'elevated' ? 0.75 : 1;
  const drawdownMultiplier = drawdownPct >= 3.5 ? 0.5 : drawdownPct >= 2 ? 0.75 : 1;
  const riskAdjustedNotional = requestedNotional * volatilityMultiplier * drawdownMultiplier;
  const approvedNotional = Math.max(0, Math.min(riskAdjustedNotional, availableNotional));

  if (approvedNotional <= 0) {
    return { decision: 'REJECTED', approvedNotional: 0, reasonCode: 'RISK_009_SYMBOL_EXPOSURE' };
  }

  if (approvedNotional < requestedNotional) {
    if (drawdownMultiplier < 1) {
      return { decision: 'REDUCED_SIZE', approvedNotional, reasonCode: 'RISK_011_DRAWDOWN_REDUCTION' };
    }
    if (volatilityMultiplier < 1) {
      return { decision: 'REDUCED_SIZE', approvedNotional, reasonCode: 'RISK_010_VOLATILITY_REDUCTION' };
    }
    return { decision: 'REDUCED_SIZE', approvedNotional, reasonCode: 'RISK_009_SYMBOL_EXPOSURE' };
  }

  return { decision: 'APPROVED', approvedNotional, reasonCode: 'RISK_OK' };
}
