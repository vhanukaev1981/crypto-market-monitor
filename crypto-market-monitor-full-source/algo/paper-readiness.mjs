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

function hasFreshPassingEvidence(item, { nowMs, maxEvidenceAgeMs, currentHeadSha }) {
  return Boolean(
    item &&
    item.result === 'PASS' &&
    Number.isFinite(item.checkedAtMs) &&
    item.checkedAtMs <= nowMs &&
    nowMs - item.checkedAtMs <= maxEvidenceAgeMs &&
    item.headSha === currentHeadSha
  );
}

export function evaluatePaperReadinessFromEvidence(input = {}) {
  const { nowMs, maxEvidenceAgeMs, currentHeadSha, evidence = {} } = input;
  const validParameters =
    Number.isFinite(nowMs) &&
    nowMs >= 0 &&
    Number.isFinite(maxEvidenceAgeMs) &&
    maxEvidenceAgeMs >= 0 &&
    typeof currentHeadSha === 'string' &&
    currentHeadSha.length > 0 &&
    evidence &&
    typeof evidence === 'object';

  if (!validParameters) {
    return {
      status: 'BLOCKED',
      blockers: ['READINESS_EVIDENCE_INVALID'],
      evidenceHeadSha: null,
    };
  }

  const context = { nowMs, maxEvidenceAgeMs, currentHeadSha };
  const result = evaluatePaperReadiness({
    dataFresh: hasFreshPassingEvidence(evidence.data, context),
    riskEngineHealthy: hasFreshPassingEvidence(evidence.riskEngine, context),
    executionEngineHealthy: hasFreshPassingEvidence(evidence.executionEngine, context),
    reconciliationHealthy: hasFreshPassingEvidence(evidence.reconciliation, context),
    oosLockActive: hasFreshPassingEvidence(evidence.oosLock, context),
    liveTradingEnabled: input.liveTradingEnabled,
    leverageEnabled: input.leverageEnabled,
  });

  return {
    ...result,
    evidenceHeadSha: currentHeadSha,
  };
}
