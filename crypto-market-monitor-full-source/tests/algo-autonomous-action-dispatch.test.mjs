import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAutonomousAction } from '../algo/autonomous-action-dispatch.mjs';

test('maps PAPER_INFRA only to the explicit RUN_PAPER_INFRA action', () => {
  assert.deepEqual(mapAutonomousAction('PAPER_INFRA'), {
    permissionAction: 'RUN_PAPER_INFRA',
    executor: 'paper-readiness-integration',
  });
});

test('fails closed for unknown and forbidden action classes', () => {
  for (const actionClass of ['LIVE_TRADING', 'LEVERAGE', 'SECRETS', 'MERGE_MAIN', 'BLIND_OOS_TUNING', 'UNKNOWN']) {
    assert.throws(
      () => mapAutonomousAction(actionClass),
      /AUTONOMOUS_ACTION_NOT_ALLOWED/,
      actionClass,
    );
  }
});
