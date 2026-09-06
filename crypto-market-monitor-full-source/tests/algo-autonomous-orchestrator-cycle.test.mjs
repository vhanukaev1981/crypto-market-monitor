import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrchestratorLoop } from '../algo/autonomous-orchestrator-loop.mjs';

// ---------------------------------------------------------------------------
// Task 8 — Persistent daemon / reconciliation loop (RED).
//
// createOrchestratorLoop({ integrationBranch, lease, fenceToken, reconcile,
//   evaluateCi, reviewGate, dispatchClaude, planContext, mutators, logger })
//   -> { runOnce(), run({ signal }), stop() }
//
// The loop composes Tasks 1-7. It holds NO authoritative local state: each tick
// rebuilds from reconcile(). Every GitHub mutation goes through `mutators` under
// the lease fence, so a stale instance or a lost lease can mutate nothing, and a
// transient reconcile error never advances state.
// ---------------------------------------------------------------------------

const INTEGRATION_BRANCH = 'agent/algobot-p0-persistent-recovery';
const HEAD = 'ab'.repeat(20);

function fakeLease({ ok = true } = {}) {
  return {
    async assertLease(token) {
      if (!ok) throw new Error('ORCHESTRATOR_LEASE_LOST: fenced out');
      if (token !== 7) throw new Error('ORCHESTRATOR_STALE_FENCE');
      return true;
    },
    async guardMutation(token, fn) {
      await this.assertLease(token);
      return fn();
    },
  };
}

function fakeReviewGate(outcome) {
  return {
    configured: true,
    async requestIndependentReview() { return { status: 'REQUESTED', requestId: 'rr-9', headSha: HEAD }; },
    async fetchReviewOutcome() { return outcome ?? { status: 'PENDING' }; },
    validateReviewEvidence: ({ evidence }) => evidence,
  };
}

function makeMutators() {
  const calls = [];
  return {
    calls,
    async integratePr(args) { calls.push(['integratePr', args]); return { merged: true }; },
    async recordReviewRequest(args) { calls.push(['recordReviewRequest', args]); },
    async recordApproval(args) { calls.push(['recordApproval', args]); },
    async postStatus(args) { calls.push(['postStatus', args]); },
  };
}

function loopWith(overrides = {}) {
  return createOrchestratorLoop({
    integrationBranch: INTEGRATION_BRANCH,
    lease: fakeLease(),
    fenceToken: 7,
    reconcile: async () => ({ derivedState: 'CLAUDE_WORKING', headSha: null, integrationBranch: INTEGRATION_BRANCH, pr: null }),
    evaluateCi: async () => ({ outcome: 'WAIT' }),
    reviewGate: fakeReviewGate(),
    dispatchClaude: async () => ({ completion: 'READY_FOR_CI' }),
    planContext: async () => ({ plan: { tasks: [] }, completedGates: [] }),
    mutators: makeMutators(),
    logger: () => {},
    ...overrides,
  });
}

test('a no-op reconciliation tick performs no mutation and reports IDLE', async () => {
  const mutators = makeMutators();
  const loop = loopWith({ mutators });
  const r = await loop.runOnce();
  assert.equal(r.status, 'OK');
  assert.equal(r.action, 'AWAIT_CLAUDE');
  assert.equal(mutators.calls.filter(([n]) => n !== 'postStatus').length, 0);
});

test('a lost lease stops the tick before any mutation', async () => {
  const mutators = makeMutators();
  const loop = loopWith({
    lease: fakeLease({ ok: false }),
    mutators,
    reconcile: async () => ({ derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt' } }),
  });
  const r = await loop.runOnce();
  assert.equal(r.status, 'LEASE_LOST');
  assert.equal(mutators.calls.length, 0, 'a fenced-out loop must not mutate anything');
});

test('a transient reconcile failure does not advance state and asks for a retry', async () => {
  const mutators = makeMutators();
  const loop = loopWith({
    mutators,
    reconcile: async () => { throw new Error('ORCHESTRATOR_RECONCILE_FAILED: getCiStatus: network boom'); },
  });
  const r = await loop.runOnce();
  assert.equal(r.status, 'TRANSIENT_ERROR');
  assert.equal(r.retry, true);
  assert.equal(mutators.calls.filter(([n]) => n !== 'postStatus').length, 0);
});

test('APPROVED + exact-SHA GREEN + exact-SHA approval -> integrate via the mutator, targeting the P0 branch', async () => {
  const mutators = makeMutators();
  const loop = loopWith({
    mutators,
    reconcile: async () => ({ derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt-independent' } }),
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'INTEGRATE');
  const call = mutators.calls.find(([n]) => n === 'integratePr');
  assert.ok(call, 'integratePr must be called');
  assert.equal(call[1].target, INTEGRATION_BRANCH);
  assert.notEqual(call[1].target, 'main');
});

test('once GitHub already shows the branch integrated, a second tick does NOT merge again', async () => {
  const mutators = makeMutators();
  let integrated = false;
  const loop = loopWith({
    mutators: {
      ...mutators,
      async integratePr(args) { integrated = true; mutators.calls.push(['integratePr', args]); return { merged: true }; },
    },
    reconcile: async () => (integrated
      ? { derivedState: 'NEXT_TASK', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH }
      : { derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt' } }),
    planContext: async () => ({ plan: { tasks: [{ id: 't-next', dependsOn: [], status: 'PENDING' }] }, completedGates: [] }),
  });
  await loop.runOnce();
  const r2 = await loop.runOnce();
  assert.equal(mutators.calls.filter(([n]) => n === 'integratePr').length, 1, 'exactly one merge');
  assert.equal(r2.action, 'SELECT_NEXT_TASK');
});

test('READY_FOR_CHATGPT_REVIEW with no reviewer configured -> fail-closed stop, no mutation', async () => {
  const mutators = makeMutators();
  const loop = loopWith({
    mutators,
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: { configured: false, async requestIndependentReview() { return { status: 'NO_INDEPENDENT_REVIEWER', failClosed: true }; }, async fetchReviewOutcome() { return { status: 'NO_INDEPENDENT_REVIEWER', failClosed: true }; } },
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_NO_INDEPENDENT_REVIEW');
  assert.equal(mutators.calls.filter(([n]) => n === 'integratePr').length, 0);
});

test('run({ signal }) exits cleanly on abort (graceful shutdown)', async () => {
  const loop = loopWith({});
  const ac = new AbortController();
  const p = loop.run({ signal: ac.signal, intervalMs: 5, maxTicks: 1000 });
  ac.abort();
  const summary = await p;
  assert.equal(summary.status, 'SHUTDOWN');
  assert.ok(summary.ticks >= 0);
});

test('a fresh loop instance (restart) reconstructs behaviour purely from reconcile()', async () => {
  const mutators = makeMutators();
  const restarted = loopWith({
    mutators,
    reconcile: async () => ({ derivedState: 'TASK_READY', headSha: null, integrationBranch: INTEGRATION_BRANCH, taskId: 'p0-task-3' }),
  });
  const r = await restarted.runOnce();
  assert.equal(r.action, 'DISPATCH_CLAUDE');
});

test('every tick emits a structured status via mutators.postStatus (secrets never included by the loop)', async () => {
  const mutators = makeMutators();
  const loop = loopWith({ mutators });
  await loop.runOnce();
  const status = mutators.calls.find(([n]) => n === 'postStatus');
  assert.ok(status, 'postStatus must be called each tick');
  assert.ok('state' in status[1] && 'action' in status[1]);
});

test('rejects a `main` integration branch at construction (fail closed)', () => {
  assert.throws(() => createOrchestratorLoop({ integrationBranch: 'main' }), /ORCHESTRATOR_SAFETY_VIOLATION/);
});

// ---------------------------------------------------------------------------
// ChatGPT PR #19 review — blockers 1 & 2 + Important fixes.
// The runtime loop must thread the real state machine and a DURABLE snapshot
// store so bounded retry, event-id dedup and the review request id survive a
// restart; the lease must be renewed each tick and a lost lease must stop the
// daemon; malformed / auth review errors and plan-load failure must fail closed.
// ---------------------------------------------------------------------------

import { createOrchestratorStateMachine } from '../algo/autonomous-orchestrator-state.mjs';

function memStateStore() {
  let blob = null;
  return {
    _peek: () => blob,
    async load() { return blob ? JSON.parse(JSON.stringify(blob)) : null; },
    async save(next) { blob = JSON.parse(JSON.stringify(next)); },
  };
}

function renewableLease({ current = 7, expired = false } = {}) {
  const calls = { renew: 0, assert: 0 };
  return {
    _calls: calls,
    async renewLease(token) {
      calls.renew += 1;
      if (expired) throw new Error('ORCHESTRATOR_LEASE_EXPIRED');
      if (token !== current) throw new Error('ORCHESTRATOR_STALE_FENCE');
      return { fenceToken: token };
    },
    async assertLease(token) {
      calls.assert += 1;
      if (expired) throw new Error('ORCHESTRATOR_LEASE_EXPIRED');
      if (token !== current) throw new Error('ORCHESTRATOR_STALE_FENCE');
      return true;
    },
    async guardMutation(token, fn) { await this.assertLease(token); return fn(); },
    async adoptLease() { throw new Error('ORCHESTRATOR_LEASE_NOT_HELD'); },
    async acquireLease() { throw new Error('ORCHESTRATOR_LEASE_HELD'); },
  };
}

const CI_FAIL_HEAD = 'cd'.repeat(20);
const REPO = 'vhanukaev1981/crypto-market-monitor';
const CLAUDE_BRANCH = 'agent/claude-p0-task3';

function durableLoop(overrides = {}) {
  return createOrchestratorLoop({
    integrationBranch: INTEGRATION_BRANCH,
    lease: renewableLease(),
    fenceToken: 7,
    stateMachine: createOrchestratorStateMachine({ integrationBranch: INTEGRATION_BRANCH, maxAttempts: 3 }),
    stateStore: memStateStore(),
    bootstrap: { repository: REPO, taskId: 'p0-task-3', branch: CLAUDE_BRANCH },
    reconcile: async () => ({ derivedState: 'CI_RUNNING', headSha: CI_FAIL_HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: CI_FAIL_HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
    evaluateCi: async (headSha, attempt) => ({ outcome: 'RETURN_TO_CLAUDE', headSha, runId: 'run-x', attempt }),
    reviewGate: fakeReviewGate(),
    dispatchClaude: async () => ({ completion: 'READY_FOR_CI' }),
    planContext: async () => ({ plan: { tasks: [{ id: 'p0-next', dependsOn: [], status: 'PENDING' }] }, completedGates: [] }),
    mutators: makeMutators(),
    logger: () => {},
    ...overrides,
  });
}

test('bounded retry is DURABLE: the attempt counter survives across restarts', async () => {
  const store = memStateStore();
  const mk = () => durableLoop({ stateStore: store, lease: renewableLease(), fenceToken: 7 });
  const r1 = await mk().runOnce();
  assert.equal(r1.action, 'RETURN_TO_CLAUDE');
  const r2 = await mk().runOnce();
  assert.equal(r2.action, 'RETURN_TO_CLAUDE');
  const r3 = await mk().runOnce();
  assert.equal(r3.action, 'STOP_UNRECOVERABLE');
});

test('the same failed CI run does not bump the durable attempt twice across ticks', async () => {
  const store = memStateStore();
  const loop = durableLoop({ stateStore: store });
  await loop.runOnce();
  const attemptAfter1 = store._peek().snapshot.attempt;
  await loop.runOnce();
  assert.equal(store._peek().snapshot.attempt, attemptAfter1);
});

test('a durable transition history is recorded through the real state machine', async () => {
  const store = memStateStore();
  await durableLoop({ stateStore: store }).runOnce();
  const snap = store._peek().snapshot;
  assert.ok(Array.isArray(snap.history) && snap.history.length >= 1);
  assert.ok(Array.isArray(snap.processedEventIds) && snap.processedEventIds.length >= 1);
});

test('the review request id is persisted and the request is not re-submitted every tick', async () => {
  const store = memStateStore();
  let submits = 0;
  const reviewGate = {
    configured: true,
    async requestIndependentReview() { submits += 1; return { status: 'REQUESTED', requestId: 'rr-persist', headSha: HEAD }; },
    async fetchReviewOutcome() { return { status: 'PENDING' }; },
  };
  const loop = durableLoop({
    stateStore: store,
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'run-1' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate,
  });
  await loop.runOnce();
  await loop.runOnce();
  assert.equal(submits, 1, 'exactly one independent-review submission for a given head');
  assert.equal(store._peek().runtime.reviewRequestId, 'rr-persist');
});

test('the lease is renewed on every tick', async () => {
  const lease = renewableLease();
  const loop = durableLoop({ lease });
  await loop.runOnce();
  await loop.runOnce();
  assert.equal(lease._calls.renew, 2);
});

test('run() stops the daemon when the lease is lost and cannot be re-acquired', async () => {
  const loop = durableLoop({ lease: renewableLease({ expired: true }) });
  const summary = await loop.run({ intervalMs: 1, maxTicks: 5 });
  assert.equal(summary.status, 'STOPPED');
  assert.match(summary.reason, /LEASE/);
});

test('a malformed review verdict fails closed (STOP_REVIEW_MALFORMED), no mutation', async () => {
  const mutators = makeMutators();
  const loop = durableLoop({
    mutators,
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: { configured: true, async requestIndependentReview() { return { status: 'REQUESTED', requestId: 'x' }; }, async fetchReviewOutcome() { throw new Error('ORCHESTRATOR_REVIEW_MALFORMED_VERDICT: got approve'); } },
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_REVIEW_MALFORMED');
  assert.equal(mutators.calls.filter(([n]) => n === 'integratePr').length, 0);
});

test('a review-client auth/permission failure fails closed (STOP_REVIEW_ERROR), not silent PENDING', async () => {
  const loop = durableLoop({
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: { configured: true, async requestIndependentReview() { return { status: 'REQUESTED', requestId: 'x' }; }, async fetchReviewOutcome() { throw new Error('HTTP 403 Forbidden: token lacks scope'); } },
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_REVIEW_ERROR');
});

test('plan-load failure is reported as STOP_PLAN_UNAVAILABLE, not BACKLOG_EXHAUSTED', async () => {
  const loop = durableLoop({
    reconcile: async () => ({ derivedState: 'NEXT_TASK', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
    planContext: async () => { throw new Error('could not read P0 plan file'); },
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_PLAN_UNAVAILABLE');
});

test('a permission-denied mutation fails closed (STOP_PERMISSION) and stops the daemon', async () => {
  const mutators = {
    ...makeMutators(),
    async integratePr() { throw new Error('HTTP 403: Resource not accessible by integration'); },
  };
  const loop = durableLoop({
    mutators,
    reconcile: async () => ({ derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'run-1' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt' } }),
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_PERMISSION');
  const summary = await loop.run({ intervalMs: 1, maxTicks: 3 });
  assert.equal(summary.status, 'STOPPED');
});
