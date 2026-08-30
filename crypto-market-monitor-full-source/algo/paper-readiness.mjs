export function evaluatePaperReadiness(input = {}) {
  const blockers = [];
  if (input.dataFresh !== true) blockers.push('DATA_NOT_FRESH');
  if (input.riskEngineHealthy !== true) blockers.push('RISK_ENGINE_UNHEALTHY');
  if (input.executionEngineHealthy !== true) blockers.push('EXECUTION_ENGINE_UNHEALTHY');
  if (input.reconciliationHealthy !== true) blockers.push('RECONCILIATION_UNHEALTHY');
  if (input.oosLockActive !== true) blockers.push('OOS_LOCK_INACTIVE');
  if (input.liveTradingEnabled !== false) blockers.push('LIVE_TRADING_MUST_BE_DISABLED');
  if (input.leverageEnabled !== false) blockers.push('LEVERAGE_MUST_BE_DISABLED');

  return {
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    blockers,
  };
}
