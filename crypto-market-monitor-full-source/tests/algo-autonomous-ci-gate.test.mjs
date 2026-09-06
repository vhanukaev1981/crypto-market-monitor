import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCiGate } from '../algo/autonomous-ci-gate.mjs';

// ---------------------------------------------------------------------------
// Task 5 — CI exact-SHA gate and bounded retry policy (RED).
//
// evaluateCiGate({ headSha, requiredChecks, runs, attempt, maxAttempts? })
//   -> { outcome: 'GREEN' | 'WAIT' | 'RETURN_TO_CLAUDE' | 'UNRECOVERABLE_FAILURE', ... }
//
// A run only counts when run.headSha === headSha. A GREEN run from an older SHA
// is invalid. Deterministic test failures return the task to Claude; repeated
// identical failure past the attempt budget escalates rather than looping.
// ---------------------------------------------------------------------------

const HEAD = 'c3'.repeat(20);
const OLD = 'd4'.repeat(20);
const CHECKS = ['orchestrator-tdd / isolated-regression', 'orchestrator-tdd / lint'];

function run(name, headSha, status, conclusion, runId = `${name}-${headSha.slice(0, 4)}`) {
  return { name, headSha, status, conclusion, runId };
}

function evalGate(overrides = {}) {
  return evaluateCiGate({
    headSha: HEAD,
    requiredChecks: CHECKS,
    runs: [],
    attempt: 1,
    ...overrides,
  });
}

test('all required checks succeeded on the exact head SHA -> GREEN', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'success'),
    run(CHECKS[1], HEAD, 'completed', 'success'),
  ];
  const r = evalGate({ runs });
  assert.equal(r.outcome, 'GREEN');
});

test('a GREEN run from an older SHA does NOT satisfy the gate -> WAIT', () => {
  const runs = [
    run(CHECKS[0], OLD, 'completed', 'success'),
    run(CHECKS[1], OLD, 'completed', 'success'),
  ];
  const r = evalGate({ runs });
  assert.equal(r.outcome, 'WAIT');
  assert.ok(r.reasons.includes('STALE_RUN_IGNORED'));
});

test('a required check still in progress on the head SHA -> WAIT', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'success'),
    run(CHECKS[1], HEAD, 'in_progress', null),
  ];
  assert.equal(evalGate({ runs }).outcome, 'WAIT');
});

test('no runs at all for the head SHA -> WAIT', () => {
  assert.equal(evalGate({ runs: [] }).outcome, 'WAIT');
});

test('a deterministic failure on the head SHA within budget -> RETURN_TO_CLAUDE', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'success'),
    run(CHECKS[1], HEAD, 'completed', 'failure'),
  ];
  const r = evalGate({ runs, attempt: 1, maxAttempts: 3 });
  assert.equal(r.outcome, 'RETURN_TO_CLAUDE');
});

test('mixed required-check results: any deterministic failure dominates a success', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'failure'),
    run(CHECKS[1], HEAD, 'completed', 'success'),
  ];
  assert.equal(evalGate({ runs, attempt: 2, maxAttempts: 3 }).outcome, 'RETURN_TO_CLAUDE');
});

test('a deterministic failure once the attempt budget is exhausted -> UNRECOVERABLE_FAILURE', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'failure'),
    run(CHECKS[1], HEAD, 'completed', 'success'),
  ];
  const r = evalGate({ runs, attempt: 3, maxAttempts: 3 });
  assert.equal(r.outcome, 'UNRECOVERABLE_FAILURE');
});

test('a transient infrastructure failure within budget -> WAIT with a retry hint', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'success'),
    run(CHECKS[1], HEAD, 'completed', 'timed_out'),
  ];
  const r = evalGate({ runs, attempt: 1, maxAttempts: 4 });
  assert.equal(r.outcome, 'WAIT');
  assert.equal(r.retry, true);
});

test('repeated transient failure past the transient budget -> UNRECOVERABLE_FAILURE', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'success'),
    run(CHECKS[1], HEAD, 'completed', 'cancelled'),
  ];
  const r = evalGate({ runs, attempt: 5, maxAttempts: 4 });
  assert.equal(r.outcome, 'UNRECOVERABLE_FAILURE');
});

test('a completed run with a null conclusion is treated as transient, not success', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'success'),
    run(CHECKS[1], HEAD, 'completed', null),
  ];
  assert.equal(evalGate({ runs, attempt: 1, maxAttempts: 4 }).outcome, 'WAIT');
});

test('skipped / neutral required checks count as passing', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'skipped'),
    run(CHECKS[1], HEAD, 'completed', 'neutral'),
  ];
  assert.equal(evalGate({ runs }).outcome, 'GREEN');
});

test('the latest run for a check on the head SHA wins over an earlier one', () => {
  const runs = [
    run(CHECKS[0], HEAD, 'completed', 'failure', 'r1'),
    run(CHECKS[0], HEAD, 'completed', 'success', 'r2'),
    run(CHECKS[1], HEAD, 'completed', 'success'),
  ];
  assert.equal(evalGate({ runs }).outcome, 'GREEN');
});

test('is a pure function — identical inputs give identical outcomes', () => {
  const runs = [run(CHECKS[0], HEAD, 'completed', 'failure'), run(CHECKS[1], HEAD, 'completed', 'success')];
  const a = evalGate({ runs, attempt: 2, maxAttempts: 3 });
  const b = evalGate({ runs, attempt: 2, maxAttempts: 3 });
  assert.deepEqual(a, b);
  // never signals permission escalation
  assert.equal('escalatePermissions' in a, false);
});

test('rejects malformed input (fail closed)', () => {
  assert.throws(() => evaluateCiGate({ headSha: 'short', requiredChecks: CHECKS, runs: [], attempt: 1 }), /ORCHESTRATOR_CI_GATE_INVALID_INPUT/);
  assert.throws(() => evaluateCiGate({ headSha: HEAD, requiredChecks: [], runs: [], attempt: 1 }), /ORCHESTRATOR_CI_GATE_INVALID_INPUT/);
  assert.throws(() => evaluateCiGate({ headSha: HEAD, requiredChecks: CHECKS, runs: 'nope', attempt: 1 }), /ORCHESTRATOR_CI_GATE_INVALID_INPUT/);
  assert.throws(() => evaluateCiGate({ headSha: HEAD, requiredChecks: CHECKS, runs: [], attempt: 0 }), /ORCHESTRATOR_CI_GATE_INVALID_INPUT/);
});

// ---------------------------------------------------------------------------
// ChatGPT PR #19 review: CI selection must use authoritative ordering
// (completedAt/startedAt timestamp, then runId), not array position.
// ---------------------------------------------------------------------------

test('the authoritative latest run is chosen by timestamp, not array order', () => {
  const runs = [
    { name: CHECKS[0], headSha: HEAD, status: 'completed', conclusion: 'success', runId: 'r2', startedAt: '2026-09-06T02:00:00Z' },
    { name: CHECKS[0], headSha: HEAD, status: 'completed', conclusion: 'failure', runId: 'r1', startedAt: '2026-09-06T01:00:00Z' }, // older, but later in the array
    { name: CHECKS[1], headSha: HEAD, status: 'completed', conclusion: 'success', runId: 'r3', startedAt: '2026-09-06T03:00:00Z' },
  ];
  assert.equal(evalGate({ runs }).outcome, 'GREEN');
});

test('with no timestamps the higher numeric runId wins deterministically', () => {
  const runs = [
    { name: CHECKS[0], headSha: HEAD, status: 'completed', conclusion: 'failure', runId: '4290000099' },
    { name: CHECKS[0], headSha: HEAD, status: 'completed', conclusion: 'success', runId: '4290000100' },
    { name: CHECKS[1], headSha: HEAD, status: 'completed', conclusion: 'success', runId: '5' },
  ];
  assert.equal(evalGate({ runs }).outcome, 'GREEN');
});
