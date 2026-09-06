// Canonical GitHub reconciliation for the ALGOBOT autonomous orchestrator
// (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// GitHub is the source of truth. This module rebuilds the actionable
// orchestrator state PURELY from an injected `github` adapter's responses.
// A local cache is accepted only to report staleness; it is never trusted to
// advance a safety transition. Every CI / review fact is exact-SHA bound, so a
// GREEN run or an approval left over from an older commit can never advance the
// pipeline.

import { isProtectedBranch } from './autonomous-orchestrator-state.mjs';

const ERR = Object.freeze({
  INPUT: 'ORCHESTRATOR_RECONCILE_INVALID_INPUT',
  SAFETY: 'ORCHESTRATOR_SAFETY_VIOLATION',
  FAILED: 'ORCHESTRATOR_RECONCILE_FAILED',
});

const REQUIRED_GITHUB_METHODS = Object.freeze([
  'getBranchHead',
  'getOpenPullRequest',
  'getCiStatus',
  'getReviewVerdict',
  'isAncestor',
]);

const REVIEW_VERDICTS = new Set([
  'APPROVED_FOR_INTEGRATION',
  'CHANGES_REQUIRED',
  'HUMAN_APPROVAL_REQUIRED',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function validateInput({ repo, integrationBranch, task, github }) {
  if (!isNonEmptyString(repo) || !repo.includes('/')) fail(ERR.INPUT, 'repo must be "owner/repo"');
  if (!isNonEmptyString(integrationBranch)) fail(ERR.INPUT, 'integrationBranch is required');
  if (isProtectedBranch(integrationBranch)) fail(ERR.SAFETY, `integrationBranch ${integrationBranch} is protected`);
  if (!task || typeof task !== 'object') fail(ERR.INPUT, 'task is required');
  if (!isNonEmptyString(task.id)) fail(ERR.INPUT, 'task.id is required');
  if (!isNonEmptyString(task.branch)) fail(ERR.INPUT, 'task.branch is required');
  if (isProtectedBranch(task.branch)) fail(ERR.SAFETY, `task.branch ${task.branch} is protected`);
  if (task.requiredChecks !== undefined && !Array.isArray(task.requiredChecks)) {
    fail(ERR.INPUT, 'task.requiredChecks must be an array');
  }
  if (!github || typeof github !== 'object') fail(ERR.INPUT, 'github adapter is required');
  for (const method of REQUIRED_GITHUB_METHODS) {
    if (typeof github[method] !== 'function') fail(ERR.INPUT, `github.${method} must be a function`);
  }
}

async function guarded(label, thunk) {
  try {
    return await thunk();
  } catch (error) {
    if (error && typeof error.message === 'string'
      && (error.message.startsWith(ERR.SAFETY) || error.message.startsWith(ERR.INPUT))) {
      throw error;
    }
    const detail = error && error.message ? error.message : String(error);
    fail(ERR.FAILED, `${label}: ${detail}`);
    return undefined; // unreachable
  }
}

function ciEvidence(ci, headSha) {
  const sha = ci && isNonEmptyString(ci.sha) ? ci.sha : null;
  const state = ci && isNonEmptyString(ci.state) ? ci.state : 'NONE';
  return {
    sha,
    state,
    runId: ci && ci.runId != null ? String(ci.runId) : null,
    matchesHead: sha !== null && sha === headSha,
  };
}

function reviewEvidence(review, headSha) {
  if (!review || !isNonEmptyString(review.sha) || !isNonEmptyString(review.verdict)) return null;
  return {
    sha: review.sha,
    verdict: review.verdict,
    matchesHead: review.sha === headSha,
    url: review.evidenceUrl != null ? String(review.evidenceUrl) : null,
    submittedAt: review.submittedAt != null ? String(review.submittedAt) : null,
  };
}

function buildResult(fields) {
  const {
    repo, integrationBranch, task, pr = null, headSha = null,
    ci = { sha: null, state: 'NONE', runId: null, matchesHead: false },
    review = null, derivedState, reasons = [], signals = [], cache,
  } = fields;

  const cacheStale = cache && typeof cache === 'object' && isNonEmptyString(cache.state)
    ? cache.state !== derivedState
    : null;

  return deepFreeze({
    repo,
    integrationBranch,
    taskId: task.id,
    branch: task.branch,
    pr: pr ? { number: pr.number, headSha: pr.headSha, baseRef: pr.baseRef, state: pr.state, merged: !!pr.merged } : null,
    headSha,
    derivedState,
    reasons: [...reasons],
    signals: [...signals],
    evidence: { ci, review },
    cacheAuthoritative: false,
    cacheStale,
    reconciledFrom: 'github',
  });
}

export async function reconcileGithubState(params = {}) {
  validateInput(params);
  const { repo, integrationBranch, task, github, cache, integrationLedger = null } = params;
  const requiredChecks = Array.isArray(task.requiredChecks) ? task.requiredChecks : [];

  const branchHead = await guarded('getBranchHead(task.branch)', () => github.getBranchHead(task.branch));
  if (!isNonEmptyString(branchHead)) {
    return buildResult({
      repo, integrationBranch, task, cache,
      derivedState: 'TASK_READY', reasons: ['TASK_BRANCH_MISSING'],
    });
  }

  const integrationHead = await guarded(
    'getBranchHead(integrationBranch)',
    () => github.getBranchHead(integrationBranch),
  );

  const pr = await guarded(
    'getOpenPullRequest',
    () => github.getOpenPullRequest({ headBranch: task.branch, baseBranch: integrationBranch }),
  );

  // Ancestry is necessary but NOT sufficient for "integrated": a freshly cut
  // task branch normally equals the integration head before Claude commits.
  const ancestry = await guarded(
    'isAncestor(branchHead, integrationBranch)',
    () => github.isAncestor(branchHead, integrationBranch),
  );

  const mergedPr = !!(pr && pr.merged === true);
  const ledgerIntegrated = integrationLedger
    ? await guarded('integrationLedger.hasIntegratedTask', () => integrationLedger.hasIntegratedTask(task.id)) === true
    : false;

  // Fresh branch still at base with no PR / no durable evidence -> Claude owes work.
  if (branchHead === integrationHead && !mergedPr && !ledgerIntegrated) {
    return buildResult({
      repo, integrationBranch, task, headSha: branchHead, cache,
      derivedState: 'CLAUDE_WORKING', reasons: ['TASK_BRANCH_AT_BASE_NO_COMMITS'],
    });
  }

  // "Integrated" requires DURABLE evidence (a merged PR or a ledger entry) in
  // addition to ancestry — ancestry alone can be an out-of-band or fast-forward
  // coincidence, so it must not advance the pipeline on its own.
  if ((mergedPr || ledgerIntegrated) && ancestry === true) {
    const integCiRaw = await guarded(
      'getCiStatus(integrationHead)',
      () => github.getCiStatus(integrationHead, requiredChecks),
    );
    const integCi = ciEvidence(integCiRaw, integrationHead);
    if (integCi.state === 'GREEN' && integCi.matchesHead) {
      return buildResult({
        repo, integrationBranch, task, headSha: branchHead, ci: integCi, cache,
        derivedState: 'NEXT_TASK', reasons: ['INTEGRATED_AND_VERIFIED'],
      });
    }
    return buildResult({
      repo, integrationBranch, task, headSha: branchHead, ci: integCi, cache,
      derivedState: 'INTEGRATING',
      reasons: ['ALREADY_INTEGRATED', 'POST_INTEGRATION_CI_PENDING'],
    });
  }

  if (!pr || !isNonEmptyString(pr.headSha)) {
    return buildResult({
      repo, integrationBranch, task, cache,
      derivedState: 'CLAUDE_WORKING', reasons: ['NO_OPEN_PULL_REQUEST'],
    });
  }

  if (pr.headSha !== branchHead) {
    return buildResult({
      repo, integrationBranch, task, pr, headSha: branchHead, cache,
      ci: ciEvidence(null, branchHead),
      derivedState: 'CLAUDE_WORKING',
      reasons: ['BRANCH_PR_SHA_MISMATCH'],
    });
  }

  const headSha = pr.headSha;

  const ciRaw = await guarded('getCiStatus', () => github.getCiStatus(headSha, requiredChecks));
  const ci = ciEvidence(ciRaw, headSha);

  const reviewRaw = await guarded('getReviewVerdict', () => github.getReviewVerdict(pr.number));
  const review = reviewEvidence(reviewRaw, headSha);

  const reasons = [];
  const signals = [];

  const ciGreenOnHead = ci.state === 'GREEN' && ci.matchesHead;
  if (!ciGreenOnHead) {
    if (ci.state === 'GREEN' && !ci.matchesHead) reasons.push('CI_STALE_FOR_HEAD');
    if (ci.state === 'FAILED' && ci.matchesHead) signals.push('CI_FAILED_ON_HEAD');
    if (ci.state === 'FAILED' && !ci.matchesHead) reasons.push('CI_STALE_FOR_HEAD');
    if (ci.state === 'PENDING' || ci.state === 'NONE') reasons.push('CI_NOT_COMPLETE_ON_HEAD');
    return buildResult({
      repo, integrationBranch, task, pr, headSha, ci, review, cache,
      derivedState: 'CI_RUNNING', reasons, signals,
    });
  }

  // CI is GREEN on the exact head. Fold in the independent-review verdict, but
  // only when it too is bound to the exact head SHA.
  const effectiveVerdict = review && review.matchesHead && REVIEW_VERDICTS.has(review.verdict)
    ? review.verdict
    : null;

  if (review && !review.matchesHead) reasons.push('REVIEW_STALE_FOR_HEAD');

  let derivedState;
  switch (effectiveVerdict) {
    case 'APPROVED_FOR_INTEGRATION':
      derivedState = 'APPROVED_FOR_INTEGRATION';
      break;
    case 'CHANGES_REQUIRED':
      derivedState = 'CHANGES_REQUIRED';
      break;
    case 'HUMAN_APPROVAL_REQUIRED':
      derivedState = 'HUMAN_APPROVAL_REQUIRED';
      break;
    default:
      derivedState = 'READY_FOR_CHATGPT_REVIEW';
      if (!review) reasons.push('AWAITING_INDEPENDENT_REVIEW');
  }

  return buildResult({
    repo, integrationBranch, task, pr, headSha, ci, review, cache,
    derivedState, reasons, signals,
  });
}
