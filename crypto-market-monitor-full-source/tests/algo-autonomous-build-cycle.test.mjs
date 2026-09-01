import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutonomousBuildCycle } from '../algo/autonomous-build-cycle.mjs';

const task = (overrides = {}) => ({
  id: 'safety-task',
  priority: 'SAFETY',
  status: 'READY',
  actionClass: 'TEST',
  retryCount: 0,
  maxRetries: 2,
  dependsOn: [],
  blocker: null,
  evidence: [],
  ...overrides,
});

const state = (tasks, overrides = {}) => ({
  version: 1,
  lease: null,
  tasks,
  lastCycle: null,
  ...overrides,
});

const input = (buildState, qualification = { status: 'PASS', runId: 36 }) => ({
  state: buildState,
  repository: {
    fullName: 'vhanukaev1981/crypto-market-monitor',
    branch: 'agent/algo-v2-hardening-v1',
    headSha: 'ef0d64bad0598404124dfd142d425e3d9210a8f8',
  },
  qualification,
});

test('selects safety work first and declares fresh evidence requirements', () => {
  const plan = planAutonomousBuildCycle(input(state([
    task({ id: 'docs', priority: 'REFACTOR', actionClass: 'DOCS' }),
    task(),
  ])));
  assert.equal(plan.status, 'WORK');
  assert.equal(plan.task.id, 'safety-task');
  assert.equal(plan.requestedAction, 'TEST');
  assert.deepEqual(plan.evidenceRequirements, ['START_SHA', 'RESULT_SHA', 'TEST_RESULT', 'WORKFLOW_RUN']);
});

test('waits while an unexpired lease is active', () => {
  const plan = planAutonomousBuildCycle(input(state([
    task({ status: 'IN_PROGRESS' }),
  ], { lease: { taskId: 'safety-task', owner: 'cycle-1', expiresAtMs: 2000 } })), { nowMs: 1000 });
  assert.deepEqual(plan, {
    status: 'WAIT',
    task: null,
    requestedAction: null,
    reasonCode: 'ACTIVE_LEASE',
    evidenceRequirements: [],
  });
});

test('returns BLOCKED when unfinished work has no eligible task', () => {
  const plan = planAutonomousBuildCycle(input(state([
    task({ status: 'BLOCKED', blocker: 'DEPENDENCY_NOT_DONE' }),
  ])));
  assert.equal(plan.status, 'BLOCKED');
  assert.equal(plan.reasonCode, 'NO_ELIGIBLE_TASK');
});

test('returns COMPLETE when every task is done', () => {
  const plan = planAutonomousBuildCycle(input(state([
    task({ status: 'DONE', evidence: ['run:36'] }),
  ])));
  assert.equal(plan.status, 'COMPLETE');
  assert.equal(plan.reasonCode, 'ALL_TASKS_DONE');
});

test('a failed qualification gives a ready regression task precedence', () => {
  const plan = planAutonomousBuildCycle(input(state([
    task(),
    task({ id: 'ci-qualification', priority: 'REGRESSION', actionClass: 'DEBUG' }),
  ]), { status: 'FAIL', runId: 37 }));
  assert.equal(plan.status, 'WORK');
  assert.equal(plan.task.id, 'ci-qualification');
  assert.equal(plan.reasonCode, 'QUALIFICATION_FAILED');
});

test('malformed or forbidden state fails closed', () => {
  assert.throws(() => planAutonomousBuildCycle(input(state([
    task({ actionClass: 'LIVE_TRADING' }),
  ]))), /AUTONOMOUS_BUILD_INVALID_STATE/);
});
