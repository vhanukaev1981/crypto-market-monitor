const MAX_COMMITTED_NOTIONAL_USD = 100;

const blocked = (reasonCode) => ({
  allowed: false,
  reasonCode,
  approvedNotionalUsd: 0,
});

export function evaluateLiveCanaryOrder(input = {}) {
  if (input.enabled !== true) return blocked('LIVE_CANARY_DISABLED');

  const qualification = input.qualification;
  if (qualification?.status !== 'PASS' || qualification.fresh !== true) {
    return blocked('QUALIFICATION_REQUIRED');
  }

  if (input.marketType !== 'SPOT' || input.leverage !== 1) {
    return blocked('SPOT_ONLY_REQUIRED');
  }

  const { requestedNotionalUsd, committedNotionalUsd } = input;
  if (
    !Number.isFinite(requestedNotionalUsd) ||
    requestedNotionalUsd <= 0 ||
    !Number.isFinite(committedNotionalUsd) ||
    committedNotionalUsd < 0
  ) {
    return blocked('INVALID_NOTIONAL');
  }

  if (committedNotionalUsd + requestedNotionalUsd > MAX_COMMITTED_NOTIONAL_USD) {
    return blocked('LIVE_CANARY_BUDGET_EXCEEDED');
  }

  return {
    allowed: true,
    reasonCode: 'ALLOW',
    approvedNotionalUsd: requestedNotionalUsd,
  };
}
