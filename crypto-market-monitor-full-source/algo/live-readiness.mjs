export function evaluateLiveReadiness(input = {}) {
  const blockers = [];
  if (input.dataFresh !== true) blockers.push('DATA_NOT_FRESH');
  if (input.riskEngineHealthy !== true) blockers.push('RISK_ENGINE_UNHEALTHY');
  if (input.executionEngineHealthy !== true) blockers.push('EXECUTION_ENGINE_UNHEALTHY');
  if (input.reconciliationHealthy !== true) blockers.push('RECONCILIATION_UNHEALTHY');
  if (input.oosLockActive !== true) blockers.push('OOS_LOCK_INACTIVE');
  if (input.leverageEnabled !== false) blockers.push('LEVERAGE_MUST_BE_DISABLED');
  if (input.marketType !== 'SPOT') blockers.push('SPOT_ONLY_REQUIRED');
  if (input.canaryBudgetUsd !== 100) blockers.push('CANARY_BUDGET_MUST_EQUAL_100_USD');
  if (!Number.isFinite(input.maxOrderNotionalUsd) || input.maxOrderNotionalUsd <= 0 || input.maxOrderNotionalUsd > 10) {
    blockers.push('MAX_ORDER_NOTIONAL_EXCEEDED');
  }
  if (input.humanApproval !== true) blockers.push('HUMAN_APPROVAL_REQUIRED');
  if (input.withdrawalPermission !== false) blockers.push('WITHDRAWAL_PERMISSION_MUST_BE_DISABLED');
  return { status: blockers.length === 0 ? 'PASS' : 'BLOCKED', blockers };
}
