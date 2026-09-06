import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrchestratorLoop } from '../algo/autonomous-orchestrator-loop.mjs';
import { reconcileGithubState } from '../algo/autonomous-github-reconciler.mjs';
import { evaluateCiGate } from '../algo/autonomous-ci-gate.mjs';
import { createReviewGate } from '../algo/autonomous-review-gate.mjs';
import { planIntegrationCycle } from '../algo/autonomous-integration-gate.mjs';

// ---------------------------------------------------------------------------
// Task 9 — Failure injection and synthetic end-to-end acceptance (RED).
//
// Drives the COMPOSED orchestrator (Tasks 1-7 via the Task 8 loop) through a
// synthetic GitHub / Claude / review world, tick by tick, with no user relay.
// Injects crashes and every negative scenario from the design's acceptance list.
// Nothing here can merge a real PR or place an order.
// ---------------------------------------------------------------------------

const REPO = 'vhanukaev1981/crypto-market-monitor';
const INTEGRATION_BRANCH = 'agent/algobot-p0-persistent-recovery';
const REQUIRED_CHECKS = ['ALGOBOT Autonomous Orchestrator TDD / isolated-regression'];

let shaSeq = 0;
const nextSha = () => (shaSeq++).toString(16).padStart(40, '0');

function createSyntheticWorld() {
  const world = {
    branches: { [INTEGRATION_BRANCH]: nextSha() },
    pr: null,
    checkRuns: [],
    review: null, // { sha, verdict, reviewerId }
    integratedShas: new Set(),
    ledger: new Set(), // durable: task ids whose integration is recorded
    claudeInvocations: 0,
    mutatorCalls: [],
    reviewRequests: [],
  };

  const github = {
    async getBranchHead(branch) {
      return Object.prototype.hasOwnProperty.call(world.branches, branch) ? world.branches[branch] : null;
    },
    async getOpenPullRequest({ headBranch, baseBranch }) {
      if (!world.pr || world.pr.headRef !== headBranch || world.pr.baseRef !== baseBranch) return null;
      return { ...world.pr };
    },
    async getCiStatus(sha) {
      const forSha = world.checkRuns.filter((r) => r.headSha === sha);
      if (forSha.length === 0) return { sha: null, state: 'NONE', runId: null };
      const allDone = forSha.every((r) => r.status === 'completed');
      const anyFail = forSha.some((r) => r.conclusion === 'failure');
      return {
        sha,
        state: !allDone ? 'PENDING' : anyFail ? 'FAILED' : 'GREEN',
        runId: forSha[forSha.length - 1].runId,
      };
    },
    async getReviewVerdict() {
      return world.review ? { ...world.review, evidenceUrl: 'synthetic://review', submittedAt: 't' } : null;
    },
    async isAncestor(sha, branch) {
      return branch === INTEGRATION_BRANCH && world.integratedShas.has(sha);
    },
  };

  const reviewClient = {
    reviewerId: 'chatgpt-independent-reviewer',
    async submitReviewRequest(p) { world.reviewRequests.push(p); return { requestId: `rr-${world.reviewRequests.length}`, status: 'QUEUED' }; },
    async fetchReviewOutcome() {
      return world.review ? { verdict: world.review.verdict, sha: world.review.sha, reviewerId: world.review.reviewerId } : null;
    },
  };

  // Simulated Claude worker: pushes a branch + opens a PR against the P0 branch.
  function simulateClaudeWork(taskBranch) {
    world.claudeInvocations += 1;
    const sha = nextSha();
    world.branches[taskBranch] = sha;
    world.pr = { number: 101, headSha: sha, headRef: taskBranch, baseRef: INTEGRATION_BRANCH, state: 'open', merged: false };
    world.checkRuns = []; // fresh commit, no CI yet
    world.review = null;
    return sha;
  }

  function advanceCi(sha, conclusion) {
    world.checkRuns = REQUIRED_CHECKS.map((name, i) => ({
      name, headSha: sha, status: 'completed', conclusion, runId: `run-${sha.slice(-4)}-${i}`,
    }));
  }

  function postReview(sha, verdict) {
    world.review = { sha, verdict, reviewerId: 'chatgpt-independent-reviewer' };
  }

  const integrationLedger = {
    async hasIntegratedTask(taskId) { return world.ledger.has(taskId); },
    async getIntegratedHead(taskId) { return world.ledger.has(taskId) ? world.branches[INTEGRATION_BRANCH] : null; },
  };

  const mutators = {
    async integratePr(args) {
      world.mutatorCalls.push(['integratePr', args]);
      if (args.target === 'main') throw new Error('E2E_FORBIDDEN_MAIN_TARGET');
      // Model a controlled merge: the task head becomes an ancestor of a NEW
      // integration-branch merge commit, durable ledger is written, PR is
      // marked merged, and post-integration CI runs GREEN on the new head.
      world.integratedShas.add(args.headSha);
      const mergeSha = nextSha();
      world.branches[INTEGRATION_BRANCH] = mergeSha;
      world.integratedShas.add(mergeSha);
      world.ledger.add(args.taskId ?? TASK.id);
      if (world.pr) world.pr = { ...world.pr, state: 'closed', merged: true };
      world.checkRuns = REQUIRED_CHECKS.map((name, i) => ({
        name, headSha: mergeSha, status: 'completed', conclusion: 'success', runId: `integ-${mergeSha.slice(-4)}-${i}`,
      }));
    },
    async recordReviewRequest(args) { world.mutatorCalls.push(['recordReviewRequest', args]); },
    async recordApproval(args) { world.mutatorCalls.push(['recordApproval', args]); },
    async recordNextTask(args) { world.mutatorCalls.push(['recordNextTask', args]); },
    async postStatus(args) { world.mutatorCalls.push(['postStatus', args]); },
  };

  return { world, github, reviewClient, mutators, integrationLedger, simulateClaudeWork, advanceCi, postReview };
}

function buildLoop(env, { task, fenceToken = 1, currentLeaseToken = 1, planContext } = {}) {
  const reviewGate = createReviewGate({ reviewClient: env.reviewClient });
  return createOrchestratorLoop({
    integrationBranch: INTEGRATION_BRANCH,
    // The canonical lease is held at `currentLeaseToken`; a stale second
    // orchestrator presents a different `fenceToken` and is fenced out.
    lease: {
      async assertLease(t) { if (t !== currentLeaseToken) throw new Error('ORCHESTRATOR_STALE_FENCE'); return true; },
      async guardMutation(t, fn) { if (t !== currentLeaseToken) throw new Error('ORCHESTRATOR_STALE_FENCE'); return fn(); },
    },
    fenceToken,
    reconcile: () => reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task, github: env.github, integrationLedger: env.integrationLedger }),
    evaluateCi: async (headSha) => evaluateCiGate({
      headSha,
      requiredChecks: REQUIRED_CHECKS,
      runs: env.world.checkRuns,
      attempt: 1,
    }),
    reviewGate,
    dispatchClaude: async () => { env.simulateClaudeWork(task.branch); return { completion: 'READY_FOR_CI' }; },
    planContext: planContext ?? (async () => ({
      plan: { tasks: [{ id: task.id, dependsOn: [], status: 'PENDING' }, { id: 'p0-next', dependsOn: [task.id], status: 'PENDING' }] },
      completedGates: [],
    })),
    mutators: env.mutators,
    logger: () => {},
  });
}

const TASK = { id: 'p0-task-3-executor-fencing', branch: 'agent/claude-p0-task3', requiredChecks: REQUIRED_CHECKS };

test('E2E happy path: TASK_READY -> Claude -> CI GREEN -> independent approval -> P0 integration -> NEXT_TASK, no relay', async () => {
  const env = createSyntheticWorld();
  const loop = buildLoop(env, { task: TASK });

  let r = await loop.runOnce();              // TASK_READY -> DISPATCH_CLAUDE
  assert.equal(r.action, 'DISPATCH_CLAUDE');
  const sha = env.world.branches[TASK.branch];

  r = await loop.runOnce();                  // CI_RUNNING -> AWAIT_CI
  assert.equal(r.action, 'AWAIT_CI');

  env.advanceCi(sha, 'success');
  r = await loop.runOnce();                  // READY_FOR_CHATGPT_REVIEW -> request review
  assert.equal(r.state, 'READY_FOR_CHATGPT_REVIEW');
  assert.equal(env.world.reviewRequests.length, 1);
  assert.equal(env.world.reviewRequests[0].headSha, sha);

  env.postReview(sha, 'APPROVED_FOR_INTEGRATION');
  r = await loop.runOnce();                  // APPROVED_FOR_INTEGRATION -> INTEGRATE
  assert.equal(r.action, 'INTEGRATE');

  r = await loop.runOnce();                  // NEXT_TASK -> SELECT_NEXT_TASK
  assert.equal(r.action, 'SELECT_NEXT_TASK');

  const integrations = env.world.mutatorCalls.filter(([n]) => n === 'integratePr');
  assert.equal(integrations.length, 1, 'exactly one integration');
  assert.equal(integrations[0][1].target, INTEGRATION_BRANCH);
  assert.notEqual(integrations[0][1].target, 'main');
});

test('crash after Claude dispatch: a restarted loop resumes at CI without re-dispatching', async () => {
  const env = createSyntheticWorld();
  let loop = buildLoop(env, { task: TASK });
  await loop.runOnce();                       // dispatch
  assert.equal(env.world.claudeInvocations, 1);

  loop = buildLoop(env, { task: TASK });      // <-- crash + restart, same world
  const r = await loop.runOnce();
  assert.equal(r.state, 'CI_RUNNING');
  assert.equal(env.world.claudeInvocations, 1, 'no duplicate Claude dispatch after restart');
});

test('crash immediately after the integration mutation: restart reconciles to NEXT_TASK, no second merge', async () => {
  const env = createSyntheticWorld();
  let loop = buildLoop(env, { task: TASK });
  const sha0 = env.simulateClaudeWork(TASK.branch);
  env.advanceCi(sha0, 'success');
  env.postReview(sha0, 'APPROVED_FOR_INTEGRATION');
  await loop.runOnce();                       // -> request review packet (state READY)
  await loop.runOnce();                       // -> INTEGRATE (mutation happens)
  assert.equal(env.world.mutatorCalls.filter(([n]) => n === 'integratePr').length, 1);

  loop = buildLoop(env, { task: TASK });      // crash + restart
  const r = await loop.runOnce();
  assert.equal(r.action, 'SELECT_NEXT_TASK');
  assert.equal(env.world.mutatorCalls.filter(([n]) => n === 'integratePr').length, 1, 'still exactly one merge');
});

test('negative: CHANGES_REQUIRED routes back to Claude (attempt increments), never integrates', async () => {
  const env = createSyntheticWorld();
  const loop = buildLoop(env, { task: TASK });
  const sha = env.simulateClaudeWork(TASK.branch);
  env.advanceCi(sha, 'success');
  await loop.runOnce();                       // request review
  env.postReview(sha, 'CHANGES_REQUIRED');
  const r = await loop.runOnce();
  assert.equal(r.action, 'RETURN_TO_CLAUDE');
  assert.equal(env.world.mutatorCalls.filter(([n]) => n === 'integratePr').length, 0);
});

test('negative: a CI failure on the head returns to Claude, never integrates', async () => {
  const env = createSyntheticWorld();
  const loop = buildLoop(env, { task: TASK });
  const sha = env.simulateClaudeWork(TASK.branch);
  env.advanceCi(sha, 'failure');
  const r = await loop.runOnce();
  assert.equal(r.action, 'RETURN_TO_CLAUDE');
  assert.equal(env.world.mutatorCalls.filter(([n]) => n === 'integratePr').length, 0);
});

test('negative: a stale approval (older SHA) does not integrate', async () => {
  const env = createSyntheticWorld();
  const loop = buildLoop(env, { task: TASK });
  const sha = env.simulateClaudeWork(TASK.branch);
  env.advanceCi(sha, 'success');
  await loop.runOnce();                       // request review
  env.postReview(nextSha(), 'APPROVED_FOR_INTEGRATION'); // approval bound to a different sha
  const r = await loop.runOnce();
  assert.equal(r.state, 'READY_FOR_CHATGPT_REVIEW');
  assert.notEqual(r.action, 'INTEGRATE');
  assert.equal(env.world.mutatorCalls.filter(([n]) => n === 'integratePr').length, 0);
});

test('negative: HUMAN_APPROVAL_REQUIRED verdict stops fail-closed for a human', async () => {
  const env = createSyntheticWorld();
  const loop = buildLoop(env, { task: TASK });
  const sha = env.simulateClaudeWork(TASK.branch);
  env.advanceCi(sha, 'success');
  await loop.runOnce();
  env.postReview(sha, 'HUMAN_APPROVAL_REQUIRED');
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_HUMAN');
});

test('negative: no independent reviewer configured -> fail-closed stop, never a self-approval', async () => {
  const env = createSyntheticWorld();
  env.reviewClient = null;
  const loop = buildLoop(env, { task: TASK });
  const sha = env.simulateClaudeWork(TASK.branch);
  env.advanceCi(sha, 'success');
  const r = await loop.runOnce();
  assert.equal(r.action, 'STOP_NO_INDEPENDENT_REVIEW');
});

test('negative: second-orchestrator contention — a stale fence token mutates nothing', async () => {
  const env = createSyntheticWorld();
  const staleLoop = buildLoop(env, { task: TASK, fenceToken: 999 }); // lease expects token 1
  const sha = env.simulateClaudeWork(TASK.branch);
  env.advanceCi(sha, 'success');
  env.postReview(sha, 'APPROVED_FOR_INTEGRATION');
  const r = await staleLoop.runOnce();
  assert.equal(r.status, 'LEASE_LOST');
  assert.equal(env.world.mutatorCalls.length, 0);
});

test('negative: LIVE_TRADING_GATE on the next task stops for a human instead of dispatching', async () => {
  const env = createSyntheticWorld();
  const planContext = async () => ({
    plan: { tasks: [{ id: 'p0-live', dependsOn: [], status: 'PENDING', gate: 'LIVE_TRADING_GATE' }] },
    completedGates: [],
  });
  const out = planIntegrationCycle({
    reconciled: { derivedState: 'NEXT_TASK', headSha: nextSha(), integrationBranch: INTEGRATION_BRANCH },
    plan: (await planContext()).plan,
    completedGates: [],
    integrationBranch: INTEGRATION_BRANCH,
  });
  assert.equal(out.action, 'STOP_LIVE_GATE');
});

test('the orchestrator never exposes a real-order / live-trading action in any mapped decision', async () => {
  const env = createSyntheticWorld();
  const forbidden = /BYBIT|ORDER|LIVE_TRADE|WITHDRAW|TRANSFER|LEVERAGE|MARGIN|FUTURES/i;
  for (const state of ['TASK_READY', 'CLAUDE_WORKING', 'CI_RUNNING', 'READY_FOR_CHATGPT_REVIEW', 'CHANGES_REQUIRED', 'APPROVED_FOR_INTEGRATION', 'INTEGRATING', 'NEXT_TASK', 'SAFETY_BLOCK', 'UNRECOVERABLE_FAILURE']) {
    const out = planIntegrationCycle({
      reconciled: { derivedState: state, headSha: nextSha(), integrationBranch: INTEGRATION_BRANCH },
      plan: { tasks: [] }, completedGates: [], integrationBranch: INTEGRATION_BRANCH,
    });
    assert.equal(forbidden.test(out.action), false, `${state} -> ${out.action}`);
  }
});
