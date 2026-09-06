import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOrchestratorStateMachine,
  ORCHESTRATOR_STATES,
  ORCHESTRATOR_EVENT_TYPES,
} from '../algo/autonomous-orchestrator-state.mjs';

// ---------------------------------------------------------------------------
// Task 1 — Deterministic orchestration state machine (RED).
//
// Pure, in-memory state machine. No network / filesystem / Claude / GitHub.
// createOrchestratorStateMachine({ integrationBranch }) -> { transition(snapshot, event) }
// returning a NEW immutable snapshot, or throwing on an invalid / safety
// transition.
// ---------------------------------------------------------------------------

const INTEGRATION_BRANCH = 'agent/algobot-p0-persistent-recovery';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let clockTick = 0;
function fixedNow() {
  clockTick += 1;
  return `2026-09-06T00:00:${String(clockTick).padStart(2, '0')}.000Z`;
}

function makeMachine(overrides = {}) {
  return createOrchestratorStateMachine({
    integrationBranch: INTEGRATION_BRANCH,
    maxAttempts: 3,
    now: fixedNow,
    ...overrides,
  });
}

function freshSnapshot(machine) {
  return machine.createInitialSnapshot({
    repository: 'vhanukaev1981/crypto-market-monitor',
    taskId: 'p0-task-3-executor-fencing',
    branch: 'agent/claude-p0-task3',
  });
}

// Drive the snapshot to a target state through the canonical happy path.
function advanceTo(machine, targetState) {
  let snap = freshSnapshot(machine);
  const steps = [
    ['CLAUDE_WORKING', { id: 'e-dispatch', type: 'CLAUDE_DISPATCHED', baseSha: SHA_A }],
    ['CI_RUNNING', { id: 'e-ready-ci', type: 'CLAUDE_READY_FOR_CI', headSha: SHA_A, prNumber: 42 }],
    ['READY_FOR_CHATGPT_REVIEW', { id: 'e-ci-green', type: 'CI_GREEN', headSha: SHA_A, ciRunId: 'run-1' }],
    ['APPROVED_FOR_INTEGRATION', {
      id: 'e-approved', type: 'REVIEW_APPROVED',
      evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: SHA_A, reviewer: 'chatgpt' },
    }],
    ['INTEGRATING', { id: 'e-integrate', type: 'INTEGRATION_STARTED', integrationTarget: INTEGRATION_BRANCH }],
    ['NEXT_TASK', { id: 'e-verified', type: 'INTEGRATION_VERIFIED' }],
  ];
  for (const [state, event] of steps) {
    if (snap.state === targetState) return snap;
    snap = machine.transition(snap, event);
    assert.equal(snap.state, state, `expected ${state} after ${event.type}`);
  }
  return snap;
}

test('exposes every canonical state and event type from the design', () => {
  for (const s of [
    'TASK_READY', 'CLAUDE_WORKING', 'CI_RUNNING', 'READY_FOR_CHATGPT_REVIEW',
    'CHANGES_REQUIRED', 'APPROVED_FOR_INTEGRATION', 'INTEGRATING', 'NEXT_TASK',
    'HUMAN_APPROVAL_REQUIRED', 'SAFETY_BLOCK', 'UNRECOVERABLE_FAILURE',
  ]) {
    assert.ok(ORCHESTRATOR_STATES.includes(s), `missing state ${s}`);
  }
  assert.ok(Object.isFrozen(ORCHESTRATOR_STATES));
  assert.ok(Array.isArray(ORCHESTRATOR_EVENT_TYPES) && ORCHESTRATOR_EVENT_TYPES.length > 0);
});

test('initial snapshot starts at TASK_READY, immutable, attempt 1', () => {
  const machine = makeMachine();
  const snap = freshSnapshot(machine);
  assert.equal(snap.state, 'TASK_READY');
  assert.equal(snap.attempt, 1);
  assert.equal(snap.integrationBranch, INTEGRATION_BRANCH);
  assert.equal(snap.headSha, null);
  assert.equal(snap.reviewEvidence, null);
  assert.ok(Object.isFrozen(snap));
  assert.throws(() => { snap.state = 'INTEGRATING'; });
});

test('walks the full canonical happy path TASK_READY -> NEXT_TASK', () => {
  const machine = makeMachine();
  const snap = advanceTo(machine, 'NEXT_TASK');
  assert.equal(snap.state, 'NEXT_TASK');
  // history is an append-only audit trail of every accepted transition
  assert.ok(Array.isArray(snap.history));
  assert.equal(snap.history[0].state, 'TASK_READY');
  assert.equal(snap.history.at(-1).state, 'NEXT_TASK');
});

test('NEXT_TASK -> TASK_READY resets per-task evidence and attempt', () => {
  const machine = makeMachine();
  let snap = advanceTo(machine, 'NEXT_TASK');
  snap = machine.transition(snap, {
    id: 'e-next', type: 'NEXT_TASK_SELECTED',
    taskId: 'p0-task-4', branch: 'agent/claude-p0-task4',
  });
  assert.equal(snap.state, 'TASK_READY');
  assert.equal(snap.taskId, 'p0-task-4');
  assert.equal(snap.branch, 'agent/claude-p0-task4');
  assert.equal(snap.attempt, 1);
  assert.equal(snap.headSha, null);
  assert.equal(snap.ciRunId, null);
  assert.equal(snap.reviewEvidence, null);
});

test('transition returns a new object and never mutates the input snapshot', () => {
  const machine = makeMachine();
  const before = freshSnapshot(machine);
  const beforeJson = JSON.stringify(before);
  const after = machine.transition(before, { id: 'e1', type: 'CLAUDE_DISPATCHED', baseSha: SHA_A });
  assert.notEqual(after, before);
  assert.equal(JSON.stringify(before), beforeJson, 'input snapshot mutated');
  assert.equal(after.state, 'CLAUDE_WORKING');
});

test('rejects an unknown event type (fail closed)', () => {
  const machine = makeMachine();
  const snap = freshSnapshot(machine);
  assert.throws(
    () => machine.transition(snap, { id: 'e-bad', type: 'TOTALLY_NOT_A_REAL_EVENT' }),
    /ORCHESTRATOR_INVALID_EVENT/,
  );
});

test('rejects an illegal transition for the current state (fail closed)', () => {
  const machine = makeMachine();
  const snap = freshSnapshot(machine); // TASK_READY
  assert.throws(
    () => machine.transition(snap, { id: 'e-x', type: 'INTEGRATION_STARTED', integrationTarget: INTEGRATION_BRANCH }),
    /ORCHESTRATOR_INVALID_TRANSITION/,
  );
});

test('duplicate event id is idempotent — returns the same snapshot, no throw', () => {
  const machine = makeMachine();
  const snap0 = freshSnapshot(machine);
  const event = { id: 'e-dispatch', type: 'CLAUDE_DISPATCHED', baseSha: SHA_A };
  const snap1 = machine.transition(snap0, event);
  const snap2 = machine.transition(snap1, event); // replay
  assert.equal(snap2.state, 'CLAUDE_WORKING');
  assert.equal(snap2, snap1, 'replayed event must be a no-op returning the identical snapshot');
  assert.equal(snap2.history.length, snap1.history.length);
});

test('CI_GREEN is bound to the exact head SHA — a stale SHA is rejected', () => {
  const machine = makeMachine();
  const snap = advanceTo(machine, 'CI_RUNNING'); // headSha = SHA_A
  assert.throws(
    () => machine.transition(snap, { id: 'e-stale-ci', type: 'CI_GREEN', headSha: SHA_B, ciRunId: 'run-x' }),
    /ORCHESTRATOR_STALE_EVIDENCE/,
  );
  // the matching SHA is accepted
  const ok = machine.transition(snap, { id: 'e-ci-green', type: 'CI_GREEN', headSha: SHA_A, ciRunId: 'run-1' });
  assert.equal(ok.state, 'READY_FOR_CHATGPT_REVIEW');
});

test('review APPROVED is bound to the exact head SHA — stale approval rejected', () => {
  const machine = makeMachine();
  const snap = advanceTo(machine, 'READY_FOR_CHATGPT_REVIEW'); // headSha = SHA_A
  assert.throws(
    () => machine.transition(snap, {
      id: 'e-stale-approve', type: 'REVIEW_APPROVED',
      evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: SHA_B },
    }),
    /ORCHESTRATOR_STALE_EVIDENCE/,
  );
});

test('a new commit makes an existing approval stale and forces re-verification', () => {
  const machine = makeMachine();
  let snap = advanceTo(machine, 'APPROVED_FOR_INTEGRATION'); // approved @ SHA_A
  snap = machine.transition(snap, { id: 'e-newcommit', type: 'NEW_COMMIT', headSha: SHA_B });
  assert.equal(snap.state, 'CI_RUNNING');
  assert.equal(snap.headSha, SHA_B);
  assert.equal(snap.reviewEvidence, null, 'stale approval must be cleared');
  assert.equal(snap.ciRunId, null, 'stale CI evidence must be cleared');
});

test('INTEGRATION_STARTED refuses to proceed on stale review evidence', () => {
  const machine = makeMachine();
  let snap = advanceTo(machine, 'APPROVED_FOR_INTEGRATION');
  // Simulate an approval snapshot whose head moved without clearing evidence.
  const tampered = Object.freeze({ ...snap, headSha: SHA_B });
  assert.throws(
    () => machine.transition(tampered, { id: 'e-int', type: 'INTEGRATION_STARTED', integrationTarget: INTEGRATION_BRANCH }),
    /ORCHESTRATOR_STALE_EVIDENCE/,
  );
});

test('HARD rejection of `main` as the integration branch at construction', () => {
  assert.throws(
    () => createOrchestratorStateMachine({ integrationBranch: 'main', now: fixedNow }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
  assert.throws(
    () => createOrchestratorStateMachine({ integrationBranch: 'refs/heads/main', now: fixedNow }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
});

test('HARD rejection of `main` as an INTEGRATION_STARTED target', () => {
  const machine = makeMachine();
  const snap = advanceTo(machine, 'APPROVED_FOR_INTEGRATION');
  assert.throws(
    () => machine.transition(snap, { id: 'e-main', type: 'INTEGRATION_STARTED', integrationTarget: 'main' }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
});

test('HARD rejection of `main` as a Claude task branch', () => {
  const machine = makeMachine();
  assert.throws(
    () => machine.createInitialSnapshot({
      repository: 'vhanukaev1981/crypto-market-monitor',
      taskId: 't', branch: 'main',
    }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
});

test('SAFETY_VIOLATION from any state moves to SAFETY_BLOCK and then locks', () => {
  const machine = makeMachine();
  let snap = advanceTo(machine, 'CI_RUNNING');
  snap = machine.transition(snap, { id: 'e-safety', type: 'SAFETY_VIOLATION', reason: 'envelope breach' });
  assert.equal(snap.state, 'SAFETY_BLOCK');
  assert.throws(
    () => machine.transition(snap, { id: 'e-after', type: 'CI_GREEN', headSha: SHA_A, ciRunId: 'r' }),
    /ORCHESTRATOR_INVALID_TRANSITION/,
  );
});

test('CI failure returns to Claude with an incremented attempt, bounded by maxAttempts', () => {
  const machine = makeMachine({ maxAttempts: 2 });
  let snap = advanceTo(machine, 'CI_RUNNING'); // attempt 1
  snap = machine.transition(snap, { id: 'e-cifail-1', type: 'CI_FAILED', headSha: SHA_A });
  assert.equal(snap.state, 'CLAUDE_WORKING');
  assert.equal(snap.attempt, 2);
  // back to CI, fail again -> exhausted -> UNRECOVERABLE_FAILURE
  snap = machine.transition(snap, { id: 'e-ready-2', type: 'CLAUDE_READY_FOR_CI', headSha: SHA_B });
  snap = machine.transition(snap, { id: 'e-cifail-2', type: 'CI_FAILED', headSha: SHA_B });
  assert.equal(snap.state, 'UNRECOVERABLE_FAILURE');
});

test('CHANGES_REQUIRED routes back to Claude on acknowledgement', () => {
  const machine = makeMachine();
  let snap = advanceTo(machine, 'READY_FOR_CHATGPT_REVIEW');
  snap = machine.transition(snap, {
    id: 'e-changes', type: 'REVIEW_CHANGES_REQUIRED',
    evidence: { verdict: 'CHANGES_REQUIRED', sha: SHA_A, findings: ['x'] },
  });
  assert.equal(snap.state, 'CHANGES_REQUIRED');
  snap = machine.transition(snap, { id: 'e-ack', type: 'CHANGES_ACKNOWLEDGED' });
  assert.equal(snap.state, 'CLAUDE_WORKING');
  assert.equal(snap.attempt, 2);
});

test('review can escalate to HUMAN_APPROVAL_REQUIRED and a human grant resumes integration', () => {
  const machine = makeMachine();
  let snap = advanceTo(machine, 'READY_FOR_CHATGPT_REVIEW');
  snap = machine.transition(snap, {
    id: 'e-human', type: 'REVIEW_HUMAN_REQUIRED',
    evidence: { verdict: 'HUMAN_APPROVAL_REQUIRED', sha: SHA_A },
  });
  assert.equal(snap.state, 'HUMAN_APPROVAL_REQUIRED');
  snap = machine.transition(snap, {
    id: 'e-human-ok', type: 'HUMAN_APPROVAL_GRANTED',
    evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: SHA_A, approver: 'vadim' },
  });
  assert.equal(snap.state, 'APPROVED_FOR_INTEGRATION');
});

test('INTEGRATION_STARTED requires CI evidence present on the approved SHA', () => {
  const machine = makeMachine();
  let snap = advanceTo(machine, 'APPROVED_FOR_INTEGRATION');
  const noCi = Object.freeze({ ...snap, ciRunId: null });
  assert.throws(
    () => machine.transition(noCi, { id: 'e-int2', type: 'INTEGRATION_STARTED', integrationTarget: INTEGRATION_BRANCH }),
    /ORCHESTRATOR_INVALID_TRANSITION/,
  );
});

test('rejects a snapshot whose integrationBranch was tampered to main', () => {
  const machine = makeMachine();
  const snap = freshSnapshot(machine);
  const tampered = Object.freeze({ ...snap, integrationBranch: 'main' });
  assert.throws(
    () => machine.transition(tampered, { id: 'e-any', type: 'CLAUDE_DISPATCHED', baseSha: SHA_A }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
});

// ---------------------------------------------------------------------------
// ChatGPT PR #19 review — Codex P2 (autonomous-orchestrator-state.mjs:331):
// duplicate-event idempotency must hold for ANY retained event id, not only
// the immediately previous one.
// ---------------------------------------------------------------------------

test('a delayed duplicate of an OLDER processed event id is still an idempotent no-op', () => {
  const machine = makeMachine();
  let snap = freshSnapshot(machine);
  const evA = { id: 'evt-A', type: 'CLAUDE_DISPATCHED', baseSha: SHA_A };
  const evB = { id: 'evt-B', type: 'CLAUDE_READY_FOR_CI', headSha: SHA_A };
  snap = machine.transition(snap, evA); // CLAUDE_WORKING
  snap = machine.transition(snap, evB); // CI_RUNNING
  const replayed = machine.transition(snap, evA); // delayed duplicate of A (not the last event)
  assert.equal(replayed, snap, 'duplicate of a non-last processed event must be a no-op');
  assert.equal(replayed.state, 'CI_RUNNING');
});

test('processed event ids are retained (bounded) and exposed for durable reconciliation', () => {
  const machine = makeMachine();
  let snap = freshSnapshot(machine);
  snap = machine.transition(snap, { id: 'e1', type: 'CLAUDE_DISPATCHED', baseSha: SHA_A });
  snap = machine.transition(snap, { id: 'e2', type: 'CLAUDE_READY_FOR_CI', headSha: SHA_A });
  assert.ok(Array.isArray(snap.processedEventIds));
  assert.ok(snap.processedEventIds.includes('e1'));
  assert.ok(snap.processedEventIds.includes('e2'));
});
