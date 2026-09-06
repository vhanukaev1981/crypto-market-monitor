const GREEN_ZONE_ACTIONS = new Set([
  'READ_REPO',
  'CREATE_BRANCH',
  'WRITE_TEST',
  'WRITE_CODE',
  'RUN_CI',
  'RUN_BACKTEST_RESEARCH',
  'RUN_PAPER_INFRA',
  'COMMIT_DEV_BRANCH',
  'UPDATE_DRAFT_PR',
  'WRITE_DOCS',
]);

const HUMAN_APPROVAL_ACTIONS = new Set([
  'MERGE_MAIN',
  'DEPLOY_PRODUCTION',
  'ENABLE_LIVE_TRADING',
  'ENABLE_LEVERAGE',
  'CHANGE_SECRET',
  'WEAKEN_RISK_LIMIT',
  'TUNE_ON_BLIND_OOS',
  'DELETE_BRANCH',
]);

export function authorizeBuildAction(input) {
  const action = input?.action;

  if (typeof action !== 'string' || !action) {
    return { allowed: false, reason: 'UNKNOWN_ACTION' };
  }

  if (GREEN_ZONE_ACTIONS.has(action)) {
    return { allowed: true, reason: 'GREEN_ZONE' };
  }

  if (HUMAN_APPROVAL_ACTIONS.has(action)) {
    return { allowed: false, reason: 'HUMAN_APPROVAL_REQUIRED' };
  }

  if (action === 'OPEN_BLIND_OOS') {
    const explicitlyApprovedVerification =
      input?.purpose === 'VERIFY_FROZEN_CANDIDATE' &&
      input?.humanApproved === true;

    return explicitlyApprovedVerification
      ? { allowed: true, reason: 'EXPLICIT_APPROVAL' }
      : { allowed: false, reason: 'HUMAN_APPROVAL_REQUIRED' };
  }

  return { allowed: false, reason: 'UNKNOWN_ACTION' };
}
