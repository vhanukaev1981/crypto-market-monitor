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

test('crash-after-integration recovery: durable evidence + verified integration head -> NEXT_TASK', async () => {
  const gh = ghWithIntegration({
    pr: { number: 77, headSha: HEAD, headRef: TASK.branch, baseRef: INTEGRATION_BRANCH, state: 'closed', merged: true },
    ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true },
    ciBySha: { [INTEG_HEAD]: { sha: INTEG_HEAD, state: 'GREEN', runId: 'run-integ' } },
  });
  const r = await reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: gh, integrationLedger: fakeLedger([TASK.id]) });
  assert.equal(r.derivedState, 'NEXT_TASK');
  assert.ok(r.reasons.includes('INTEGRATED_AND_VERIFIED'));
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

test('once durably integrated, PR-head review lookups are skipped (only the integration head is verified)', async () => {
  const gh = ghWithIntegration({
    pr: { number: 77, headSha: HEAD, headRef: TASK.branch, baseRef: INTEGRATION_BRANCH, state: 'closed', merged: true },
    ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true },
    ciBySha: { [INTEG_HEAD]: { sha: INTEG_HEAD, state: 'GREEN', runId: 'run-integ' } },
  });
  const r = await reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: gh, integrationLedger: fakeLedger([TASK.id]) });
  assert.equal(r.derivedState, 'NEXT_TASK');
  assert.equal(gh._calls.getReviewVerdict, 0, 'no PR-head review lookup after integration');
  assert.equal(gh._calls.getCiStatus, 1, 'exactly one CI lookup: the integration-head post-integration verification');
});

// ---------------------------------------------------------------------------
// ChatGPT PR #19 review — blocker 3 (post-integration verification) and
// Codex P1 (reconciler:149): ancestry alone must NOT mean "integrated".
//   * a fresh task branch still at the integration head is NOT integrated
//   * "already integrated" requires durable evidence (merged PR or ledger)
//   * NEXT_TASK requires exact-SHA GREEN on the integration branch head
// ---------------------------------------------------------------------------

const INTEG_HEAD = 'g'.repeat(40);

function ghWithIntegration(overrides = {}) {
  const gh = fakeGithub({
    branchHeads: { [TASK.branch]: HEAD, [INTEGRATION_BRANCH]: INTEG_HEAD },
    ...overrides,
  });
  // getCiStatus answers per-sha in this variant (head vs integration head).
  const ciBySha = overrides.ciBySha ?? { [HEAD]: { sha: HEAD, state: 'GREEN', runId: 'run-h' } };
  gh.getCiStatus = async (sha) => {
    gh._calls.getCiStatus += 1;
    return ciBySha[sha] ?? { sha: null, state: 'NONE', runId: null };
  };
  return gh;
}

function fakeLedger(integratedTaskIds = []) {
  const set = new Set(integratedTaskIds);
  return {
    async hasIntegratedTask(taskId) { return set.has(taskId); },
    async getIntegratedHead(taskId) { return set.has(taskId) ? HEAD : null; },
  };
}

test('a fresh task branch still pointing at the integration head is NOT treated as integrated', async () => {
  const gh = ghWithIntegration({
    branchHeads: { [TASK.branch]: INTEG_HEAD, [INTEGRATION_BRANCH]: INTEG_HEAD },
    pr: null,
    ancestors: { [`${INTEG_HEAD}->${INTEGRATION_BRANCH}`]: true },
  });
  const r = await reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: gh, integrationLedger: fakeLedger() });
  assert.notEqual(r.derivedState, 'NEXT_TASK');
  assert.ok(['CLAUDE_WORKING', 'TASK_READY'].includes(r.derivedState), r.derivedState);
  assert.ok(r.reasons.some((x) => /NO_COMMITS|AT_BASE/.test(x)), JSON.stringify(r.reasons));
});

test('ancestry true but NO merged PR and NO ledger entry does NOT claim NEXT_TASK (fail closed)', async () => {
  const gh = ghWithIntegration({
    pr: null,
    ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true },
  });
  const r = await reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: gh, integrationLedger: fakeLedger() });
  assert.notEqual(r.derivedState, 'NEXT_TASK');
});

test('durable ledger entry + ancestry + exact-SHA GREEN on the integration head -> NEXT_TASK', async () => {
  const gh = ghWithIntegration({
    pr: null,
    ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true },
    ciBySha: { [INTEG_HEAD]: { sha: INTEG_HEAD, state: 'GREEN', runId: 'run-integ' } },
  });
  const r = await reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: gh, integrationLedger: fakeLedger([TASK.id]) });
  assert.equal(r.derivedState, 'NEXT_TASK');
  assert.ok(r.reasons.includes('INTEGRATED_AND_VERIFIED'));
});

test('durable integration but the integration head CI is not yet GREEN -> INTEGRATING (post-integration verify)', async () => {
  const gh = ghWithIntegration({
    pr: null,
    ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true },
    ciBySha: { [INTEG_HEAD]: { sha: INTEG_HEAD, state: 'PENDING', runId: 'run-integ' } },
  });
  const r = await reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: gh, integrationLedger: fakeLedger([TASK.id]) });
  assert.equal(r.derivedState, 'INTEGRATING');
  assert.ok(r.reasons.includes('POST_INTEGRATION_CI_PENDING'));
});

test('a merged PR is durable evidence of integration (ledger not required)', async () => {
  const gh = ghWithIntegration({
    pr: { number: 77, headSha: HEAD, headRef: TASK.branch, baseRef: INTEGRATION_BRANCH, state: 'closed', merged: true },
    ancestors: { [`${HEAD}->${INTEGRATION_BRANCH}`]: true },
    ciBySha: { [INTEG_HEAD]: { sha: INTEG_HEAD, state: 'GREEN', runId: 'run-integ' } },
  });
  const r = await reconcileGithubState({ repo: REPO, integrationBranch: INTEGRATION_BRANCH, task: TASK, github: gh, integrationLedger: fakeLedger() });
  assert.equal(r.derivedState, 'NEXT_TASK');
});
