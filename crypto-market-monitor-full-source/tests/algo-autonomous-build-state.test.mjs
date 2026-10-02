import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBuildState,
  selectNextTask,
  transitionTask,
} from '../algo/autonomous-build-state.mjs';

const task = (overrides = {}) => ({
  id: 'task-a',
  priority: 'SAFETY',
  status: 'READY',
  actionClass: 'TEST',
  retryCount: 0,
  maxRetries: 3,
  dependsOn: [],
  blocker: null,
  evidence: [],
  ...overrides,
});

const state = (tasks = [task()]) => ({
  version: 1,
  lease: null,
  tasks,
  lastCycle: null,
});

test('validates a minimal autonomous build state', () => {
  assert.equal(validateBuildState(state()), true);
});

test('rejects malformed state fail closed', () => {
  for (const invalid of [null, {}, { ...state(), version: 2 }, { ...state(), tasks: null }]) {
    assert.throws(() => validateBuildState(invalid), /AUTONOMOUS_BUILD_INVALID_STATE/);
  }
});

test('rejects duplicate IDs, unknown status or priority, invalid retries, and forbidden action classes', () => {
  const cases = [
    state([task(), task()]),
    state([task({ status: 'UNKNOWN' })]),
    state([task({ priority: 'UNKNOWN' })]),
    state([task({ retryCount: -1 })]),
    state([task({ maxRetries: -1 })]),
    state([task({ actionClass: 'LIVE_TRADING' })]),
  ];
  for (const invalid of cases) {
    assert.throws(() => validateBuildState(invalid), /AUTONOMOUS_BUILD_INVALID_STATE/);
  }
});

test('selects READY task by priority then task ID deterministically', () => {
  const selected = selectNextTask(state([
    task({ id: 'z', priority: 'REGRESSION' }),
    task({ id: 'b', priority: 'SAFETY' }),
    task({ id: 'a', priority: 'SAFETY' }),
  ]));
  assert.equal(selected.id, 'a');
});

test('enforces task transition rules', () => {
  const started = transitionTask(state(), 'task-a', 'IN_PROGRESS');
  assert.equal(started.tasks[0].status, 'IN_PROGRESS');
  const done = transitionTask(started, 'task-a', 'DONE', ['ci:1']);
  assert.equal(done.tasks[0].status, 'DONE');
  assert.deepEqual(done.tasks[0].evidence, ['ci:1']);
  assert.throws(() => transitionTask(done, 'task-a', 'READY'), /AUTONOMOUS_BUILD_INVALID_TRANSITION/);
});

test('BLOCKED can retry only while retry budget remains', () => {
  const retryable = state([task({ status: 'BLOCKED', retryCount: 1, maxRetries: 2 })]);
  const retried = transitionTask(retryable, 'task-a', 'READY');
  assert.equal(retried.tasks[0].status, 'READY');
  const exhausted = state([task({ status: 'BLOCKED', retryCount: 2, maxRetries: 2 })]);
  assert.throws(() => transitionTask(exhausted, 'task-a', 'READY'), /AUTONOMOUS_BUILD_INVALID_TRANSITION/);
});
