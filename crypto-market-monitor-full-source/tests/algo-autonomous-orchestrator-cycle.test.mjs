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
  // Each retry is a DISTINCT failed CI run (Claude re-worked -> new head sha).
  const mk = (n) => durableLoop({
    stateStore: store,
    lease: renewableLease(),
    fenceToken: 7,
    reconcile: async () => ({ derivedState: 'CI_RUNNING', headSha: String(n).repeat(40).slice(0, 40), integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: String(n).repeat(40).slice(0, 40) }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
    evaluateCi: async (headSha, attempt) => ({ outcome: 'RETURN_TO_CLAUDE', headSha, runId: `run-${n}`, attempt }),
  });
  const r1 = await mk(1).runOnce(); // attempt 1 -> fail -> attempt 2
  assert.equal(r1.action, 'RETURN_TO_CLAUDE');
  const r2 = await mk(2).runOnce(); // restart; attempt 2 -> fail -> attempt 3
  assert.equal(r2.action, 'RETURN_TO_CLAUDE');
  const r3 = await mk(3).runOnce(); // restart; attempt 3 -> fail -> exhausted
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
  const seeded = memStateStore();
  await seeded.save({ snapshot: createOrchestratorStateMachine({ integrationBranch: INTEGRATION_BRANCH }).createInitialSnapshot({ repository: REPO, taskId: 'p0-task-3', branch: CLAUDE_BRANCH }), runtime: { reviewRequestId: 'rr-seed', reviewRequestSha: HEAD, pendingReviewFor: HEAD, dispatch: null } });
  const loop = durableLoop({
    mutators, stateStore: seeded,
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: { configured: true, async requestIndependentReview() { return { status: 'REQUESTED', requestId: 'x' }; }, async fetchReviewOutcome() { throw new Error('ORCHESTRATOR_REVIEW_MALFORMED_VERDICT: got approve'); } },
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_REVIEW_MALFORMED');
  assert.equal(mutators.calls.filter(([n]) => n === 'integratePr').length, 0);
});

test('a review-client auth/permission failure fails closed (STOP_REVIEW_ERROR), not silent PENDING', async () => {
  const seeded = memStateStore();
  await seeded.save({ snapshot: createOrchestratorStateMachine({ integrationBranch: INTEGRATION_BRANCH }).createInitialSnapshot({ repository: REPO, taskId: 'p0-task-3', branch: CLAUDE_BRANCH }), runtime: { reviewRequestId: 'rr-seed', reviewRequestSha: HEAD, pendingReviewFor: HEAD, dispatch: null } });
  const loop = durableLoop({
    stateStore: seeded,
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

// ===========================================================================
// ChatGPT PR #19 re-review 2 — Commit G (durable state fail-closed, atomic
// fence at mutation, real next-task handoff, review-request durability).
// ===========================================================================

test('R5: a stateStore.load() IO error STOPS the tick fail-closed, no mutation', async () => {
  const mutators = makeMutators();
  const loop = durableLoop({
    mutators,
    stateStore: { async load() { throw new Error('EIO: state file unreadable'); }, async save() {} },
    reconcile: async () => ({ derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'r' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt' } }),
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_STATE_UNAVAILABLE');
  assert.equal(mutators.calls.filter(([n]) => n === 'integratePr').length, 0);
});

test('R5: a persisted-but-invalid snapshot STOPS fail-closed (no silent reset)', async () => {
  const store = { async load() { return { snapshot: { state: 'NOT_A_REAL_STATE', version: 1 }, runtime: {} }; }, async save() {} };
  const loop = durableLoop({
    stateStore: store,
    reconcile: async () => ({ derivedState: 'CI_RUNNING', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_STATE_INVALID');
});

test('R5: a stateStore.save() failure STOPS and does NOT execute the decision', async () => {
  const mutators = makeMutators();
  const loop = durableLoop({
    mutators,
    stateStore: { async load() { return null; }, async save() { throw new Error('ORCHESTRATOR_ADAPTER_AUTH: 403 on state PUT'); } },
    reconcile: async () => ({ derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'r' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt' } }),
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_STATE_PERSIST_FAILED');
  assert.equal(mutators.calls.filter(([n]) => n === 'integratePr').length, 0);
});

test('R2: the lease fence is re-asserted immediately before each mutation', async () => {
  let asserts = 0;
  const lease = {
    async renewLease() { return { fenceToken: 7 }; },
    async assertLease() { asserts += 1; if (asserts >= 2) throw new Error('ORCHESTRATOR_STALE_FENCE: taken over between assert and act'); return true; },
    async guardMutation(t, fn) { await this.assertLease(t); return fn(); },
    async adoptLease() { throw new Error('ORCHESTRATOR_LEASE_NOT_HELD'); },
    async acquireLease() { throw new Error('ORCHESTRATOR_LEASE_HELD'); },
  };
  const mutators = makeMutators();
  const loop = durableLoop({
    lease,
    mutators,
    reconcile: async () => ({ derivedState: 'APPROVED_FOR_INTEGRATION', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'r' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt' } }),
  });
  const r = await loop.runOnce();
  assert.equal(r.status, 'LEASE_LOST');
  assert.equal(mutators.calls.filter(([n]) => n === 'integratePr').length, 0, 'no mutation once the fence is lost');
});

test('R3: SELECT_NEXT_TASK records a fresh branch + real base sha via recordNextTask', async () => {
  const calls = [];
  const mutators = { ...makeMutators(), async recordNextTask(a) { calls.push(a); } };
  const INTEG_HEAD = 'ee'.repeat(20);
  const loop = durableLoop({
    mutators,
    reconcile: async () => ({ derivedState: 'NEXT_TASK', headSha: INTEG_HEAD, integrationHead: INTEG_HEAD, integrationBranch: INTEGRATION_BRANCH, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }),
    planContext: async () => ({ plan: { tasks: [{ id: 'p0-task-3-executor-fencing', dependsOn: [], status: 'DONE' }, { id: 'p0-task-4-live-canary', dependsOn: ['p0-task-3-executor-fencing'], status: 'PENDING' }] }, completedGates: ['p0-task-3-executor-fencing'] }),
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'SELECT_NEXT_TASK');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, 'p0-task-4-live-canary');
  assert.match(calls[0].branch, /^agent\/claude-/);
  assert.equal(calls[0].baseSha, INTEG_HEAD);
  assert.doesNotMatch(calls[0].baseSha, /^0+$/);
});

test('R4: the review-request intent is persisted BEFORE submitting; a failed submit is retried at most once', async () => {
  const store = memStateStore();
  let submits = 0;
  const reviewGate = {
    configured: true,
    async requestIndependentReview() { submits += 1; if (submits === 1) throw new Error('review submit 503'); return { status: 'REQUESTED', requestId: 'rr-2', headSha: HEAD }; },
    async fetchReviewOutcome() { return { status: 'PENDING' }; },
  };
  const mk = () => durableLoop({
    stateStore: store,
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'r' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate,
  });
  await mk().runOnce().catch(() => {}); // submit throws -> intent persisted, no id
  assert.equal(store._peek().runtime.pendingReviewFor, HEAD);
  assert.equal(store._peek().runtime.reviewRequestId ?? null, null);
  await mk().runOnce(); // retry
  assert.equal(submits, 2);
  await mk().runOnce(); // id now present -> no third submit
  assert.equal(submits, 2);
});

test('R4: an APPROVED verdict is written as canonical evidence via recordApproval', async () => {
  const calls = [];
  const mutators = { ...makeMutators(), async recordApproval(a) { calls.push(a); } };
  const loop = durableLoop({
    mutators,
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'r' }, review: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt-independent', matchesHead: true } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate: fakeReviewGate({ status: 'COMPLETE', evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt-independent' } }),
  });
  await loop.runOnce();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].verdict, 'APPROVED_FOR_INTEGRATION');
  assert.equal(calls[0].sha, HEAD);
  assert.equal(calls[0].reviewerId, 'chatgpt-independent');
});

// ===========================================================================
// ChatGPT PR #19 re-review 3 — Commit J (loop end-to-end control flow).
// B1: a freshly selected task must actually get Claude DISPATCHED.
// B2: a detached dispatch is durable; the loop never re-dispatches the same
//     task/branch (same tick, next tick, or after restart).
// B4: a crash after the review endpoint ACCEPTED the submit but before the id
//     persisted must poll + adopt, not re-submit.
// B6: reconcile() ADAPTER_AUTH -> STOP_PERMISSION (not transient); run() STOPS
//     on LEASE_LOST (no reacquire-continue).
// Copilot loop:275: no synthetic-id poll before a request exists.
// ===========================================================================

test('B1: a freshly selected task actually gets Claude dispatched (not stuck at AWAIT)', async () => {
  const store = memStateStore();
  const dispatched = [];
  const INTEG_HEAD = 'ee'.repeat(20);
  let phase = 'nexttask';
  const loop = () => durableLoop({
    stateStore: store,
    dispatchClaude: async ({ reconciled }) => { dispatched.push(reconciled.taskId); return { completion: 'DISPATCHED' }; },
    reconcile: async () => (phase === 'nexttask'
      ? { derivedState: 'NEXT_TASK', headSha: INTEG_HEAD, integrationHead: INTEG_HEAD, integrationBranch: INTEGRATION_BRANCH, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3' }
      // after recordNextTask, the new task branch sits at the integration head, no PR yet
      : { derivedState: 'TASK_READY', headSha: INTEG_HEAD, integrationHead: INTEG_HEAD, integrationBranch: INTEGRATION_BRANCH, repo: REPO, branch: 'agent/claude-p0-task-4-x', taskId: 'p0-task-4-x', pr: null }),
    planContext: async () => ({ plan: { tasks: [{ id: 'p0-task-3', dependsOn: [], status: 'DONE' }, { id: 'p0-task-4-x', dependsOn: ['p0-task-3'], status: 'PENDING' }] }, completedGates: ['p0-task-3'] }),
    mutators: { ...makeMutators(), async recordNextTask() { phase = 'taskready'; } },
  });
  const r1 = await loop().runOnce();
  assert.equal(r1.action, 'SELECT_NEXT_TASK');
  const r2 = await loop().runOnce();
  assert.equal(r2.action, 'DISPATCH_CLAUDE');
  assert.deepEqual(dispatched, ['p0-task-4-x']);
});

test('B2: a detached dispatch is not repeated on the next tick or after restart', async () => {
  const store = memStateStore();
  let dispatches = 0;
  const HH = '11'.repeat(20);
  const mk = () => durableLoop({
    stateStore: store,
    dispatchClaude: async () => { dispatches += 1; return { completion: 'DISPATCHED' }; },
    reconcile: async () => ({ derivedState: 'TASK_READY', headSha: HH, integrationHead: HH, integrationBranch: INTEGRATION_BRANCH, repo: REPO, branch: 'agent/claude-p0-task-4-x', taskId: 'p0-task-4-x', pr: null }),
    planContext: async () => ({ plan: { tasks: [{ id: 'p0-task-4-x', dependsOn: [], status: 'PENDING' }] }, completedGates: [] }),
  });
  await mk().runOnce(); // dispatch
  await mk().runOnce(); // same GitHub state -> must NOT re-dispatch
  await mk().runOnce(); // restart -> must NOT re-dispatch
  assert.equal(dispatches, 1);
  assert.ok(store._peek().runtime.dispatch, 'the dispatch is recorded durably');
});

test('B4: crash after an accepted submit -> next tick polls + adopts, never re-submits', async () => {
  const store = memStateStore();
  let submits = 0;
  let pollCalls = 0;
  const reviewGate = {
    configured: true,
    async requestIndependentReview() { submits += 1; return { status: 'REQUESTED', requestId: 'rr-accepted', headSha: HEAD }; },
    async fetchReviewOutcome(id) {
      pollCalls += 1;
      // the endpoint keys by sha: it already has the accepted request
      return { status: 'PENDING', requestId: 'rr-accepted' };
    },
  };
  // 1) first loop: persist the intent, submit succeeds, but we simulate a crash
  //    BEFORE the id is persisted by wrapping stateStore.save to throw once
  //    after the intent write.
  let saves = 0;
  const crashingStore = {
    async load() { return store._peek(); },
    async save(b) { saves += 1; if (saves === 3) throw new Error("crash before id persisted"); await store.save(b); },
  };
  const base = {
    stateStore: crashingStore,
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'r' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate,
  };
  await durableLoop(base).runOnce().catch(() => {});
  assert.equal(submits, 1);
  // 2) recovery tick with the real store
  await durableLoop({ ...base, stateStore: store }).runOnce();
  assert.equal(submits, 1, 'no duplicate paid submission after an accepted-but-uncommitted request');
  assert.equal(store._peek().runtime.reviewRequestId, 'rr-accepted');
});

test('B6a: reconcile() ADAPTER_AUTH stops fail-closed (STOP_PERMISSION), not a transient retry', async () => {
  const loop = durableLoop({
    reconcile: async () => { throw new Error('ORCHESTRATOR_ADAPTER_AUTH: GitHub 403 on /git/ref/heads/x'); },
  });
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_PERMISSION');
});

test('B6b: run() STOPS on LEASE_LOST (no reacquire-and-continue split-brain)', async () => {
  const loop = durableLoop({ lease: renewableLease({ expired: true }) });
  const summary = await loop.run({ intervalMs: 1, maxTicks: 4 });
  assert.equal(summary.status, 'STOPPED');
  assert.match(summary.reason, /LEASE/);
});

test('Copilot loop:275: gatherReview does not poll with a synthetic id before any request exists', async () => {
  let polls = 0;
  const reviewGate = {
    configured: true,
    async requestIndependentReview() { return { status: 'REQUESTED', requestId: 'rr-x', headSha: HEAD }; },
    async fetchReviewOutcome() { polls += 1; throw new Error('unknown request id'); },
  };
  const loop = durableLoop({
    reconcile: async () => ({ derivedState: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD, integrationBranch: INTEGRATION_BRANCH, pr: { number: 5, headSha: HEAD }, repo: REPO, branch: CLAUDE_BRANCH, taskId: 'p0-task-3', evidence: { ci: { runId: 'r' } } }),
    evaluateCi: async () => ({ outcome: 'GREEN', headSha: HEAD }),
    reviewGate,
  });
  const r = await loop.runOnce();
  assert.equal(polls, 0, 'no fetchReviewOutcome before a request is submitted');
  assert.equal(r.action, 'REQUEST_REVIEW');
});
