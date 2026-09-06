// Controlled P0 integration gate and next-task selection for the ALGOBOT
// autonomous orchestrator
// (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Pure decisions only. No GitHub mutation happens here — the daemon performs the
// actual controlled integration behind an adapter after this gate returns
// INTEGRATE. Integration requires an exact-SHA GREEN CI evidence AND an
// exact-SHA independent APPROVED verdict, targets ONLY the configured P0
// integration branch, and hard-rejects `main`. Next-task selection honours the
// approved P0 plan's dependency order and never skips an incomplete prerequisite.

import { isProtectedBranch } from './autonomous-orchestrator-state.mjs';

const ERR = Object.freeze({
  SAFETY: 'ORCHESTRATOR_SAFETY_VIOLATION',
  INPUT: 'ORCHESTRATOR_INTEGRATION_INVALID_INPUT',
});

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value.trim());
}

function assertSafeIntegrationBranch(name, label) {
  if (typeof name !== 'string' || !name.trim()) fail(ERR.INPUT, `${label} is required`);
  if (isProtectedBranch(name)) fail(ERR.SAFETY, `${label} ${name} is a protected branch`);
}

function frozen(decision, target, reasons) {
  return Object.freeze({
    decision,
    target: decision === 'INTEGRATE' ? target : null,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

export function evaluateIntegrationGate(input = {}) {
  const { snapshot, ciEvidence, reviewEvidence, integrationBranch, headSha } = input;

  assertSafeIntegrationBranch(integrationBranch, 'integrationBranch');
  if (snapshot && isProtectedBranch(snapshot.integrationBranch)) {
    fail(ERR.SAFETY, `snapshot.integrationBranch ${snapshot.integrationBranch} is a protected branch`);
  }
  if (!isFullSha(headSha)) fail(ERR.INPUT, 'headSha must be a full commit SHA');
  if (!snapshot || typeof snapshot !== 'object') fail(ERR.INPUT, 'snapshot is required');
  if (snapshot.integrationBranch !== undefined && snapshot.integrationBranch !== integrationBranch) {
    fail(ERR.INPUT, 'snapshot.integrationBranch does not match integrationBranch');
  }

  const reasons = [];

  if (snapshot.state !== 'APPROVED_FOR_INTEGRATION') {
    reasons.push('SNAPSHOT_NOT_APPROVED');
    return frozen('WAIT', null, reasons);
  }

  if (!reviewEvidence || typeof reviewEvidence !== 'object') {
    reasons.push('MISSING_REVIEW_EVIDENCE');
    return frozen('WAIT', null, reasons);
  }
  if (reviewEvidence.verdict === 'CHANGES_REQUIRED') {
    reasons.push('REVIEW_CHANGES_REQUIRED');
    return frozen('BLOCK', null, reasons);
  }
  if (reviewEvidence.verdict === 'HUMAN_APPROVAL_REQUIRED') {
    reasons.push('REVIEW_HUMAN_APPROVAL_REQUIRED');
    return frozen('STOP_HUMAN', null, reasons);
  }
  if (reviewEvidence.verdict !== 'APPROVED_FOR_INTEGRATION') {
    reasons.push('REVIEW_NOT_APPROVED');
    return frozen('WAIT', null, reasons);
  }
  if (reviewEvidence.sha !== headSha) {
    reasons.push('REVIEW_STALE_FOR_HEAD');
    return frozen('WAIT', null, reasons);
  }

  if (!ciEvidence || typeof ciEvidence !== 'object') {
    reasons.push('MISSING_CI_EVIDENCE');
    return frozen('WAIT', null, reasons);
  }
  const ciGreen = ciEvidence.outcome === 'GREEN' || ciEvidence.state === 'GREEN';
  if (!ciGreen) {
    reasons.push('CI_NOT_GREEN');
    return frozen('WAIT', null, reasons);
  }
  if (ciEvidence.headSha !== headSha) {
    reasons.push('CI_STALE_FOR_HEAD');
    return frozen('WAIT', null, reasons);
  }

  if (snapshot.headSha !== undefined && snapshot.headSha !== headSha) {
    reasons.push('SNAPSHOT_HEAD_MISMATCH');
    return frozen('WAIT', null, reasons);
  }

  reasons.push('EXACT_SHA_GREEN_AND_APPROVED');
  return frozen('INTEGRATE', integrationBranch, reasons);
}

export function selectNextP0Task(plan, completedGates = []) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks)) {
    fail(ERR.INPUT, 'plan.tasks must be an array');
  }
  if (!Array.isArray(completedGates) && !(completedGates instanceof Set)) {
    fail(ERR.INPUT, 'completedGates must be an array or Set');
  }

  const done = new Set(completedGates instanceof Set ? [...completedGates] : completedGates);
  for (const task of plan.tasks) {
    if (task && task.status === 'DONE') done.add(task.id);
  }

  for (const task of plan.tasks) {
    if (!task || typeof task.id !== 'string') fail(ERR.INPUT, 'each plan task needs a string id');
    if (done.has(task.id)) continue;
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    if (deps.every((d) => done.has(d))) {
      return Object.freeze({
        task: Object.freeze({
          id: task.id,
          dependsOn: Object.freeze([...deps]),
          status: task.status ?? 'PENDING',
          gate: task.gate ?? null,
        }),
        reason: 'DEPENDENCIES_SATISFIED',
      });
    }
  }
  return Object.freeze({ task: null, reason: 'NO_DEPENDENCY_SATISFIED_INCOMPLETE_TASK' });
}

export function planIntegrationCycle(input = {}) {
  const { reconciled, ciGate, reviewOutcome, plan, completedGates = [], integrationBranch } = input;

  assertSafeIntegrationBranch(integrationBranch, 'integrationBranch');
  if (!reconciled || typeof reconciled !== 'object') fail(ERR.INPUT, 'reconciled is required');
  if (isProtectedBranch(reconciled.integrationBranch)) {
    fail(ERR.SAFETY, `reconciled.integrationBranch ${reconciled.integrationBranch} is a protected branch`);
  }

  const state = reconciled.derivedState;
  const headSha = reconciled.headSha;

  const decide = () => {
    switch (state) {
      case 'TASK_READY':
        return { action: 'DISPATCH_CLAUDE', taskId: reconciled.taskId ?? null };
      case 'CLAUDE_WORKING':
        return { action: 'AWAIT_CLAUDE' };
      case 'CI_RUNNING':
        if (ciGate && ciGate.outcome === 'RETURN_TO_CLAUDE') return { action: 'RETURN_TO_CLAUDE' };
        if (ciGate && ciGate.outcome === 'UNRECOVERABLE_FAILURE') return { action: 'STOP_UNRECOVERABLE' };
        return { action: 'AWAIT_CI' };
      case 'READY_FOR_CHATGPT_REVIEW': {
        if (!reviewOutcome || reviewOutcome.status === 'NO_INDEPENDENT_REVIEWER' || reviewOutcome.failClosed === true) {
          return { action: 'STOP_NO_INDEPENDENT_REVIEW' };
        }
        if (reviewOutcome.status === 'COMPLETE') {
          const verdict = reviewOutcome.evidence?.verdict;
          if (verdict === 'CHANGES_REQUIRED') return { action: 'RETURN_TO_CLAUDE' };
          if (verdict === 'HUMAN_APPROVAL_REQUIRED') return { action: 'STOP_HUMAN' };
          if (verdict === 'APPROVED_FOR_INTEGRATION') return { action: 'RECORD_APPROVAL' };
          return { action: 'AWAIT_OR_REQUEST_REVIEW' };
        }
        return { action: 'AWAIT_OR_REQUEST_REVIEW' };
      }
      case 'CHANGES_REQUIRED':
        return { action: 'RETURN_TO_CLAUDE' };
      case 'HUMAN_APPROVAL_REQUIRED':
        return { action: 'STOP_HUMAN' };
      case 'APPROVED_FOR_INTEGRATION': {
        const d = evaluateIntegrationGate({
          snapshot: { state: 'APPROVED_FOR_INTEGRATION', headSha, integrationBranch },
          ciEvidence: ciGate && ciGate.outcome === 'GREEN'
            ? { outcome: 'GREEN', headSha: ciGate.headSha ?? headSha }
            : ciGate ?? null,
          reviewEvidence: reviewOutcome?.evidence ?? null,
          integrationBranch,
          headSha,
        });
        if (d.decision === 'INTEGRATE') return { action: 'INTEGRATE', target: integrationBranch };
        if (d.decision === 'BLOCK') return { action: 'RETURN_TO_CLAUDE' };
        if (d.decision === 'STOP_HUMAN') return { action: 'STOP_HUMAN' };
        return { action: 'AWAIT_INTEGRATION_PRECONDITIONS' };
      }
      case 'INTEGRATING':
        return { action: 'AWAIT_INTEGRATION' };
      case 'NEXT_TASK': {
        const next = selectNextP0Task(plan, completedGates);
        if (!next.task) return { action: 'BACKLOG_EXHAUSTED' };
        // A task explicitly gated on LIVE trading or human sign-off is never
        // auto-dispatched — the loop stops for a human decision.
        if (next.task.gate === 'LIVE_TRADING_GATE') return { action: 'STOP_LIVE_GATE', taskId: next.task.id };
        if (next.task.gate === 'HUMAN_APPROVAL_REQUIRED') return { action: 'STOP_HUMAN', taskId: next.task.id };
        return { action: 'SELECT_NEXT_TASK', taskId: next.task.id };
      }
      case 'SAFETY_BLOCK':
        return { action: 'STOP_SAFETY' };
      case 'UNRECOVERABLE_FAILURE':
        return { action: 'STOP_UNRECOVERABLE' };
      default:
        return { action: 'STOP_UNRECOVERABLE', unknownState: state };
    }
  };

  const out = decide();
  if (out.target !== undefined && isProtectedBranch(out.target)) {
    fail(ERR.SAFETY, `cycle decision target ${out.target} is a protected branch`);
  }
  return Object.freeze({ target: null, ...out, state });
}
