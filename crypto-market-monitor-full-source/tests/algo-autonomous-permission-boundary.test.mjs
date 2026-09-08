import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeBuildAction } from '../algo/autonomous-permission-boundary.mjs';

const allowed = ['READ_REPO','CREATE_BRANCH','WRITE_TEST','WRITE_CODE','RUN_CI','RUN_BACKTEST_RESEARCH','RUN_PAPER_INFRA','COMMIT_DEV_BRANCH','UPDATE_DRAFT_PR','WRITE_DOCS'];
const forbidden = ['MERGE_MAIN','DEPLOY_PRODUCTION','ENABLE_LIVE_TRADING','ENABLE_LEVERAGE','CHANGE_SECRET','WEAKEN_RISK_LIMIT','TUNE_ON_BLIND_OOS','DELETE_BRANCH'];

test('allows reversible development-only actions', () => {
  for (const action of allowed) assert.deepEqual(authorizeBuildAction({ action }), { allowed: true, reason: 'GREEN_ZONE' });
});

test('blocks hard-stop actions requiring explicit human approval', () => {
  for (const action of forbidden) assert.deepEqual(authorizeBuildAction({ action }), { allowed: false, reason: 'HUMAN_APPROVAL_REQUIRED' });
});

test('unknown or malformed action fails closed', () => {
  for (const input of [null, {}, { action: '' }, { action: 'UNKNOWN_ACTION' }]) {
    assert.deepEqual(authorizeBuildAction(input), { allowed: false, reason: 'UNKNOWN_ACTION' });
  }
});

test('blind OOS research access is blocked unless it is an explicit verification-only gate', () => {
  assert.deepEqual(authorizeBuildAction({ action: 'OPEN_BLIND_OOS', purpose: 'TUNING' }), { allowed: false, reason: 'HUMAN_APPROVAL_REQUIRED' });
  assert.deepEqual(authorizeBuildAction({ action: 'OPEN_BLIND_OOS', purpose: 'VERIFY_FROZEN_CANDIDATE', humanApproved: true }), { allowed: true, reason: 'EXPLICIT_APPROVAL' });
});
