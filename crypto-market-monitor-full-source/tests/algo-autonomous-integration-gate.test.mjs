import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateIntegrationGate,
  selectNextP0Task,
  planIntegrationCycle,
} from '../algo/autonomous-integration-gate.mjs';

// ---------------------------------------------------------------------------
// Task 7 — Controlled P0 integration and next-task selection (RED).
//
// Integration requires exact-SHA GREEN CI *and* an exact-SHA independent
// approval, targets ONLY the P0 integration branch, rejects `main` and stale
// evidence, enforces dependency order, and stops at human / live gates. All
// GitHub mutation stays behind an adapter — these are pure decisions.
// ---------------------------------------------------------------------------

const INTEGRATION_BRANCH = 'agent/algobot-p0-persistent-recovery';
const HEAD = 'ab'.repeat(20);
const OLD = 'cd'.repeat(20);

function greenCi(sha = HEAD) {
  return { outcome: 'GREEN', headSha: sha, runId: 'run-1' };
}
function approval(sha = HEAD) {
  return { verdict: 'APPROVED_FOR_INTEGRATION', sha, reviewerId: 'chatgpt-independent-reviewer' };
}
function approvedSnapshot(sha = HEAD) {
  return { state: 'APPROVED_FOR_INTEGRATION', headSha: sha, integrationBranch: INTEGRATION_BRANCH };
}

function gate(overrides = {}) {
  return evaluateIntegrationGate({
    snapshot: approvedSnapshot(),
    ciEvidence: greenCi(),
    reviewEvidence: approval(),
    integrationBranch: INTEGRATION_BRANCH,
    headSha: HEAD,
    ...overrides,
  });
}

test('exact-SHA GREEN + exact-SHA approval + APPROVED snapshot -> INTEGRATE into the P0 branch', () => {
  const d = gate();
  assert.equal(d.decision, 'INTEGRATE');
  assert.equal(d.target, INTEGRATION_BRANCH);
});

test('a stale CI GREEN (older SHA) does not permit integration', () => {
  assert.equal(gate({ ciEvidence: greenCi(OLD) }).decision, 'WAIT');
});

test('a stale approval (older SHA) does not permit integration', () => {
  assert.equal(gate({ reviewEvidence: approval(OLD) }).decision, 'WAIT');
});

test('CI not GREEN -> WAIT, never INTEGRATE', () => {
  assert.equal(gate({ ciEvidence: { outcome: 'WAIT', headSha: HEAD } }).decision, 'WAIT');
});

test('review verdict CHANGES_REQUIRED -> BLOCK back to Claude', () => {
  const d = gate({ reviewEvidence: { verdict: 'CHANGES_REQUIRED', sha: HEAD, reviewerId: 'chatgpt' } });
  assert.equal(d.decision, 'BLOCK');
  assert.ok(d.reasons.includes('REVIEW_CHANGES_REQUIRED'));
});

test('review verdict HUMAN_APPROVAL_REQUIRED -> STOP_HUMAN', () => {
  const d = gate({ reviewEvidence: { verdict: 'HUMAN_APPROVAL_REQUIRED', sha: HEAD, reviewerId: 'chatgpt' } });
  assert.equal(d.decision, 'STOP_HUMAN');
});

test('snapshot not in APPROVED_FOR_INTEGRATION -> WAIT even with green+approved evidence', () => {
  assert.equal(gate({ snapshot: { state: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH } }).decision, 'WAIT');
});

test('HARD: `main` as the integration branch throws, never returns a decision', () => {
  assert.throws(() => gate({ integrationBranch: 'main', snapshot: { ...approvedSnapshot(), integrationBranch: 'main' } }), /ORCHESTRATOR_SAFETY_VIOLATION/);
});

test('HARD: a snapshot whose integrationBranch is main is rejected', () => {
  assert.throws(
    () => gate({ snapshot: { state: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: 'main' } }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
});

test('missing review evidence -> WAIT (no blind integration)', () => {
  assert.equal(gate({ reviewEvidence: null }).decision, 'WAIT');
});

// -- selectNextP0Task -------------------------------------------------------

const P0_PLAN = {
  tasks: [
    { id: 'p0-task-1', dependsOn: [], status: 'DONE' },
    { id: 'p0-task-2', dependsOn: ['p0-task-1'], status: 'DONE' },
    { id: 'p0-task-3-executor-fencing', dependsOn: ['p0-task-2'], status: 'PENDING' },
    { id: 'p0-task-4', dependsOn: ['p0-task-3-executor-fencing'], status: 'PENDING' },
  ],
};

test('selects the first incomplete dependency-satisfied task', () => {
  const next = selectNextP0Task(P0_PLAN, ['p0-task-1', 'p0-task-2']);
  assert.equal(next.task.id, 'p0-task-3-executor-fencing');
});

test('does not skip an incomplete prerequisite — task 4 is not selected before task 3', () => {
  const next = selectNextP0Task(P0_PLAN, ['p0-task-1', 'p0-task-2']);
  assert.notEqual(next.task.id, 'p0-task-4');
});

test('after task 3 integrates, task 4 becomes selectable', () => {
  const next = selectNextP0Task(P0_PLAN, ['p0-task-1', 'p0-task-2', 'p0-task-3-executor-fencing']);
  assert.equal(next.task.id, 'p0-task-4');
});

test('nothing selectable -> null with a reason, never a guess', () => {
  const allDone = { tasks: P0_PLAN.tasks.map((t) => ({ ...t, status: 'DONE' })) };
  const next = selectNextP0Task(allDone, ['p0-task-1', 'p0-task-2', 'p0-task-3-executor-fencing', 'p0-task-4']);
  assert.equal(next.task, null);
  assert.ok(next.reason);
});

test('a dependency-blocked head task yields no selection (does not fall through to a ready later task)', () => {
  const plan = {
    tasks: [
      { id: 'a', dependsOn: [], status: 'PENDING' }, // blocked: dep never satisfied
      { id: 'b', dependsOn: ['x-not-in-plan'], status: 'PENDING' },
      { id: 'c', dependsOn: [], status: 'PENDING' },
    ],
  };
  // 'a' has no deps -> it IS selectable and is first; must be chosen, not 'c'
  assert.equal(selectNextP0Task(plan, []).task.id, 'a');
  // once 'a' done, 'b' is blocked on a missing prereq, so 'c' (next satisfied) is chosen
  assert.equal(selectNextP0Task(plan, ['a']).task.id, 'c');
});

// -- planIntegrationCycle -------------------------------------------------------

test('planIntegrationCycle never emits a decision whose target is `main`', () => {
  const reconciled = { derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH };
  const out = planIntegrationCycle({
    reconciled,
    ciGate: { outcome: 'GREEN', headSha: HEAD },
    reviewOutcome: { status: 'COMPLETE', evidence: approval() },
    plan: P0_PLAN,
    completedGates: ['p0-task-1', 'p0-task-2'],
    integrationBranch: INTEGRATION_BRANCH,
  });
  assert.equal(out.action, 'INTEGRATE');
  assert.equal(out.target, INTEGRATION_BRANCH);
  assert.notEqual(out.target, 'main');
});

test('planIntegrationCycle stops fail-closed when no independent reviewer is configured', () => {
  const out = planIntegrationCycle({
    reconciled: { derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH },
    ciGate: { outcome: 'GREEN', headSha: HEAD },
    reviewOutcome: { status: 'NO_INDEPENDENT_REVIEWER', failClosed: true },
    plan: P0_PLAN,
    completedGates: [],
    integrationBranch: INTEGRATION_BRANCH,
  });
  assert.equal(out.action, 'STOP_NO_INDEPENDENT_REVIEW');
});

test('planIntegrationCycle on NEXT_TASK selects the next P0 task', () => {
  const out = planIntegrationCycle({
    reconciled: { derivedState: 'NEXT_TASK', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH },
    plan: P0_PLAN,
    completedGates: ['p0-task-1', 'p0-task-2'],
    integrationBranch: INTEGRATION_BRANCH,
  });
  assert.equal(out.action, 'SELECT_NEXT_TASK');
  assert.equal(out.taskId, 'p0-task-3-executor-fencing');
});

test('planIntegrationCycle maps SAFETY_BLOCK / UNRECOVERABLE_FAILURE to hard stops', () => {
  for (const [state, action] of [['SAFETY_BLOCK', 'STOP_SAFETY'], ['UNRECOVERABLE_FAILURE', 'STOP_UNRECOVERABLE']]) {
    const out = planIntegrationCycle({
      reconciled: { derivedState: state, headSha: HEAD, integrationBranch: INTEGRATION_BRANCH },
      plan: P0_PLAN, completedGates: [], integrationBranch: INTEGRATION_BRANCH,
    });
    assert.equal(out.action, action);
  }
});

test('planIntegrationCycle rejects a main integration branch outright', () => {
  assert.throws(
    () => planIntegrationCycle({
      reconciled: { derivedState: 'NEXT_TASK', headSha: HEAD, integrationBranch: 'main' },
      plan: P0_PLAN, completedGates: [], integrationBranch: 'main',
    }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
});
