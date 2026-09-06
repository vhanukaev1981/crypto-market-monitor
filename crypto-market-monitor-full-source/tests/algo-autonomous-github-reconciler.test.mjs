import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileGithubState } from '../algo/autonomous-github-reconciler.mjs';
import { ORCHESTRATOR_STATES } from '../algo/autonomous-orchestrator-state.mjs';

// ---------------------------------------------------------------------------
// Task 2 — Canonical GitHub reconciliation and restart recovery (RED).
//
// reconcileGithubState({ repo, integrationBranch, task, github, cache? })
//   -> Promise<ReconciledState>
//
// GitHub evidence is canonical. A local cache is never authoritative: after a
// restart the actionable state is rebuilt purely from the injected `github`
// adapter's responses. Every CI / review fact is exact-SHA bound.
// ---------------------------------------------------------------------------

const REPO = 'vhanukaev1981/crypto-market-monitor';
const INTEGRATION_BRANCH = 'agent/algobot-p0-persistent-recovery';
const TASK = {
  id: 'p0-task-3-executor-fencing',
  branch: 'agent/claude-p0-task3',
  requiredChecks: ['ALGOBOT Autonomous Orchestrator TDD / isolated-regression'],
};
const HEAD = 'h'.repeat(40);
const OLD = 'o'.repeat(40);

// Build a fully controllable fake GitHub adapter.
function fakeGithub(overrides = {}) {
  const state = {
    branchHeads: { [TASK.branch]: HEAD, [INTEGRATION_BRANCH]: 'i'.repeat(40) },
    pr: {
      number: 77, headSha: HEAD, headRef: TASK.branch, baseRef: INTEGRATION_BRANCH,
      state: 'open', merged: false,
    },
    ci: { sha: HEAD, state: 'GREEN', runId: 'run-900', checks: [] },
    review: null, // { sha, verdict, evidenceUrl, submittedAt }
    ancestors: {}, // `${sha}->${branch}`: true
    ...overrides,
  };
  const calls = { getCiStatus: 0, getReviewVerdict: 0 };
  return {
    _state: state,
    _calls: calls,
    async getBranchHead(branch) {
      return Object.prototype.hasOwnProperty.call(state.branchHeads, branch)
        ? state.branchHeads[branch] : null;
    },
    async getOpenPullRequest({ headBranch, baseBranch }) {
      if (!state.pr) return null;
      if (state.pr.headRef !== headBranch || state.pr.baseRef !== baseBranch) return null;
      return { ...state.pr };
    },
    async getCiStatus(sha /* , requiredChecks */) {
      calls.getCiStatus += 1;
      // Models "latest CI run known for this PR/branch"; the run carries its own
      // sha and the reconciler is responsible for the exact-SHA comparison.
      if (!state.ci) return { sha: null, state: 'NONE', runId: null, checks: [] };
      return { ...state.ci };
    },
    async getReviewVerdict(prNumber) {
      calls.getReviewVerdict += 1;
      if (!state.review || prNumber !== state.pr?.number) return null;
      return { ...state.review };
    },
    async isAncestor(sha, branch) {
      return state.ancestors[`${sha}->${branch}`] === true;
    },
  };
}

function reconcile(github, extra = {}) {
  return reconcileGithubState({
    repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github, ...extra,
  });
}

test('derivedState is always a canonical orchestrator state', async () => {
  const r = await reconcile(fakeGithub());
  assert.ok(ORCHESTRATOR_STATES.includes(r.derivedState), r.derivedState);
});

test('happy path: PR head == branch head, CI GREEN on head, no review -> READY_FOR_CHATGPT_REVIEW', async () => {
  const r = await reconcile(fakeGithub());
  assert.equal(r.derivedState, 'READY_FOR_CHATGPT_REVIEW');
  assert.equal(r.headSha, HEAD);
  assert.equal(r.pr.number, 77);
  assert.equal(r.evidence.ci.state, 'GREEN');
  assert.equal(r.evidence.ci.matchesHead, true);
  assert.equal(r.evidence.review, null);
  assert.equal(r.cacheAuthoritative, false);
});

test('APPROVED review on the exact head SHA -> APPROVED_FOR_INTEGRATION', async () => {
  const gh = fakeGithub({ review: { sha: HEAD, verdict: 'APPROVED_FOR_INTEGRATION', evidenceUrl: 'u', submittedAt: '2026-09-06T00:00:00Z' } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'APPROVED_FOR_INTEGRATION');
  assert.equal(r.evidence.review.matchesHead, true);
});

test('stale CI GREEN (run is for an older SHA) does NOT advance past CI_RUNNING', async () => {
  const gh = fakeGithub({ ci: { sha: OLD, state: 'GREEN', runId: 'run-old', checks: [] } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'CI_RUNNING');
  assert.equal(r.evidence.ci.matchesHead, false);
  assert.ok(r.reasons.includes('CI_STALE_FOR_HEAD'));
});

test('stale review approval (approved an older SHA) is ignored -> READY_FOR_CHATGPT_REVIEW', async () => {
  const gh = fakeGithub({ review: { sha: OLD, verdict: 'APPROVED_FOR_INTEGRATION', evidenceUrl: 'u', submittedAt: 't' } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'READY_FOR_CHATGPT_REVIEW');
  assert.equal(r.evidence.review.matchesHead, false);
  assert.ok(r.reasons.includes('REVIEW_STALE_FOR_HEAD'));
});

test('CHANGES_REQUIRED review on head SHA -> CHANGES_REQUIRED', async () => {
  const gh = fakeGithub({ review: { sha: HEAD, verdict: 'CHANGES_REQUIRED', evidenceUrl: 'u', submittedAt: 't' } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'CHANGES_REQUIRED');
});

test('HUMAN_APPROVAL_REQUIRED review on head SHA -> HUMAN_APPROVAL_REQUIRED', async () => {
  const gh = fakeGithub({ review: { sha: HEAD, verdict: 'HUMAN_APPROVAL_REQUIRED', evidenceUrl: 'u', submittedAt: 't' } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'HUMAN_APPROVAL_REQUIRED');
});

test('CI failed on the current head -> CI_RUNNING with a return-to-Claude signal', async () => {
  const gh = fakeGithub({ ci: { sha: HEAD, state: 'FAILED', runId: 'run-901', checks: [] } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'CI_RUNNING');
  assert.ok(r.signals.includes('CI_FAILED_ON_HEAD'));
});

test('missing PR -> CLAUDE_WORKING (Claude still owes a PR), no advance', async () => {
  const gh = fakeGithub({ pr: null });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'CLAUDE_WORKING');
  assert.equal(r.pr, null);
  assert.ok(r.reasons.includes('NO_OPEN_PULL_REQUEST'));
});

test('missing task branch -> TASK_READY', async () => {
  const gh = fakeGithub({ branchHeads: { [INTEGRATION_BRANCH]: 'i'.repeat(40) } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'TASK_READY');
  assert.ok(r.reasons.includes('TASK_BRANCH_MISSING'));
});

test('inconsistent branch/PR SHA -> fail closed to CLAUDE_WORKING, evidence marked stale', async () => {
  const gh = fakeGithub({ pr: { number: 77, headSha: OLD, headRef: TASK.branch, baseRef: INTEGRATION_BRANCH, state: 'open', merged: false } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'CLAUDE_WORKING');
  assert.ok(r.reasons.includes('BRANCH_PR_SHA_MISMATCH'));
});

test('crash-after-integration recovery: head already absorbed by integration branch -> NEXT_TASK', async () => {
  const gh = fakeGithub({ ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true } });
  const r = await reconcile(gh);
  assert.equal(r.derivedState, 'NEXT_TASK');
  assert.ok(r.reasons.includes('ALREADY_INTEGRATED'));
});

test('duplicate observations are idempotent — same inputs give a deep-equal result', async () => {
  const a = await reconcile(fakeGithub());
  const b = await reconcile(fakeGithub());
  assert.deepEqual(a, b);
});

test('local cache is never authoritative: cache says APPROVED but GitHub shows CI failed -> CI_RUNNING + cacheStale', async () => {
  const gh = fakeGithub({ ci: { sha: HEAD, state: 'FAILED', runId: 'r', checks: [] } });
  const cache = { state: 'APPROVED_FOR_INTEGRATION', headSha: HEAD };
  const r = await reconcile(gh, { cache });
  assert.equal(r.derivedState, 'CI_RUNNING');
  assert.equal(r.cacheAuthoritative, false);
  assert.equal(r.cacheStale, true);
});

test('cache matching the reconciled state is reported as not stale', async () => {
  const cache = { state: 'READY_FOR_CHATGPT_REVIEW', headSha: HEAD };
  const r = await reconcile(fakeGithub(), { cache });
  assert.equal(r.cacheStale, false);
});

test('rejects `main` as the integration branch (fail closed)', async () => {
  await assert.rejects(
    () => reconcileGithubState({ repo: REPO, integrationBranch: 'main', task: TASK, github: fakeGithub() }),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
});

test('rejects a malformed github adapter (fail closed)', async () => {
  await assert.rejects(
    () => reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: {} }),
    /ORCHESTRATOR_RECONCILE_INVALID_INPUT/,
  );
});

test('a throwing github adapter surfaces as ORCHESTRATOR_RECONCILE_FAILED, never a false advance', async () => {
  const gh = fakeGithub();
  gh.getCiStatus = async () => { throw new Error('network boom'); };
  await assert.rejects(() => reconcile(gh), /ORCHESTRATOR_RECONCILE_FAILED/);
});

test('does not call CI/review lookups once the branch is already integrated', async () => {
  const gh = fakeGithub({ ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true } });
  await reconcile(gh);
  assert.equal(gh._calls.getCiStatus, 0);
  assert.equal(gh._calls.getReviewVerdict, 0);
});
