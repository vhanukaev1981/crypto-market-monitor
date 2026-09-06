// Deterministic orchestration state machine for the ALGOBOT full autonomous
// orchestrator (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// This module is PURE. It performs no network, filesystem, Claude, or GitHub
// calls. It only computes the next immutable orchestrator snapshot from the
// current snapshot plus a single machine-readable event, or throws a
// fail-closed error on an invalid or safety-violating transition.
//
// Canonical evidence still lives in GitHub; `history` here is a bounded local
// audit convenience only.

export const ORCHESTRATOR_STATES = Object.freeze([
  'TASK_READY',
  'CLAUDE_WORKING',
  'CI_RUNNING',
  'READY_FOR_CHATGPT_REVIEW',
  'CHANGES_REQUIRED',
  'APPROVED_FOR_INTEGRATION',
  'INTEGRATING',
  'NEXT_TASK',
  'HUMAN_APPROVAL_REQUIRED',
  'SAFETY_BLOCK',
  'UNRECOVERABLE_FAILURE',
]);

export const ORCHESTRATOR_EVENT_TYPES = Object.freeze([
  'CLAUDE_DISPATCHED',
  'CLAUDE_READY_FOR_CI',
  'CI_GREEN',
  'CI_FAILED',
  'NEW_COMMIT',
  'REVIEW_APPROVED',
  'REVIEW_CHANGES_REQUIRED',
  'REVIEW_HUMAN_REQUIRED',
  'CHANGES_ACKNOWLEDGED',
  'HUMAN_APPROVAL_GRANTED',
  'INTEGRATION_STARTED',
  'INTEGRATION_VERIFIED',
  'INTEGRATION_FAILED',
  'NEXT_TASK_SELECTED',
  'SAFETY_VIOLATION',
]);

export const ORCHESTRATOR_TERMINAL_STATES = Object.freeze(['SAFETY_BLOCK', 'UNRECOVERABLE_FAILURE']);

const ERR = Object.freeze({
  CONFIG: 'ORCHESTRATOR_INVALID_CONFIG',
  SNAPSHOT: 'ORCHESTRATOR_INVALID_SNAPSHOT',
  EVENT: 'ORCHESTRATOR_INVALID_EVENT',
  TRANSITION: 'ORCHESTRATOR_INVALID_TRANSITION',
  STALE: 'ORCHESTRATOR_STALE_EVIDENCE',
  SAFETY: 'ORCHESTRATOR_SAFETY_VIOLATION',
});

const STATE_SET = new Set(ORCHESTRATOR_STATES);
const EVENT_SET = new Set(ORCHESTRATOR_EVENT_TYPES);
const HISTORY_LIMIT = 200;
const SNAPSHOT_VERSION = 1;

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// A branch that autonomous automation must never write to or target.
export function isProtectedBranch(name) {
  if (!isNonEmptyString(name)) return false;
  const normalized = name.trim().replace(/^refs\/heads\//, '');
  return normalized === 'main' || normalized === 'master';
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function defaultNow() {
  return new Date().toISOString();
}

function assertSha(value, label) {
  if (!isNonEmptyString(value)) fail(ERR.EVENT, `${label} must be a non-empty string`);
}

function evidenceForSha(evidence, expectedSha, expectedVerdict) {
  if (!evidence || typeof evidence !== 'object') fail(ERR.EVENT, 'review evidence object is required');
  if (!isNonEmptyString(evidence.sha)) fail(ERR.EVENT, 'review evidence.sha is required');
  if (evidence.sha !== expectedSha) {
    fail(ERR.STALE, `review evidence sha ${evidence.sha} does not match head ${expectedSha}`);
  }
  if (expectedVerdict && evidence.verdict !== expectedVerdict) {
    fail(ERR.EVENT, `review evidence.verdict must be ${expectedVerdict}`);
  }
  return { ...evidence };
}

export function createOrchestratorStateMachine(config = {}) {
  const { integrationBranch, maxAttempts = 3, now = defaultNow } = config;

  if (!isNonEmptyString(integrationBranch)) fail(ERR.CONFIG, 'integrationBranch is required');
  if (isProtectedBranch(integrationBranch)) {
    fail(ERR.SAFETY, `integrationBranch ${integrationBranch} is a protected branch`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) fail(ERR.CONFIG, 'maxAttempts must be a positive integer');
  if (typeof now !== 'function') fail(ERR.CONFIG, 'now must be a function');

  function createInitialSnapshot(input = {}) {
    const { repository, taskId, branch } = input;
    if (!isNonEmptyString(repository) || !repository.includes('/')) {
      fail(ERR.SNAPSHOT, 'repository must be "owner/repo"');
    }
    if (!isNonEmptyString(taskId)) fail(ERR.SNAPSHOT, 'taskId is required');
    if (!isNonEmptyString(branch)) fail(ERR.SNAPSHOT, 'branch is required');
    if (isProtectedBranch(branch)) fail(ERR.SAFETY, `task branch ${branch} is a protected branch`);

    const at = now();
    return deepFreeze({
      version: SNAPSHOT_VERSION,
      state: 'TASK_READY',
      repository,
      taskId,
      branch,
      integrationBranch,
      prNumber: null,
      baseSha: null,
      headSha: null,
      ciRunId: null,
      reviewEvidence: null,
      attempt: 1,
      updatedAt: at,
      reason: 'INITIALIZED',
      lastEventId: null,
      history: [{ state: 'TASK_READY', eventId: null, at, reason: 'INITIALIZED' }],
    });
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') fail(ERR.SNAPSHOT, 'snapshot object required');
    if (snapshot.version !== SNAPSHOT_VERSION) fail(ERR.SNAPSHOT, 'unsupported snapshot version');
    if (!STATE_SET.has(snapshot.state)) fail(ERR.SNAPSHOT, `unknown state ${snapshot.state}`);
    if (!isNonEmptyString(snapshot.repository) || !snapshot.repository.includes('/')) {
      fail(ERR.SNAPSHOT, 'snapshot.repository invalid');
    }
    if (!isNonEmptyString(snapshot.taskId)) fail(ERR.SNAPSHOT, 'snapshot.taskId invalid');
    if (!isNonEmptyString(snapshot.branch)) fail(ERR.SNAPSHOT, 'snapshot.branch invalid');
    if (isProtectedBranch(snapshot.branch)) fail(ERR.SAFETY, 'snapshot.branch is a protected branch');
    if (isProtectedBranch(snapshot.integrationBranch)) {
      fail(ERR.SAFETY, 'snapshot.integrationBranch is a protected branch');
    }
    if (snapshot.integrationBranch !== integrationBranch) {
      fail(ERR.SNAPSHOT, 'snapshot.integrationBranch does not match this machine');
    }
    if (!Number.isInteger(snapshot.attempt) || snapshot.attempt < 1) fail(ERR.SNAPSHOT, 'snapshot.attempt invalid');
    if (!Array.isArray(snapshot.history)) fail(ERR.SNAPSHOT, 'snapshot.history invalid');
    for (const field of ['prNumber']) {
      if (!(snapshot[field] === null || Number.isInteger(snapshot[field]))) fail(ERR.SNAPSHOT, `snapshot.${field} invalid`);
    }
    for (const field of ['baseSha', 'headSha', 'ciRunId', 'lastEventId']) {
      if (!(snapshot[field] === null || isNonEmptyString(snapshot[field]))) fail(ERR.SNAPSHOT, `snapshot.${field} invalid`);
    }
    if (!(snapshot.reviewEvidence === null || typeof snapshot.reviewEvidence === 'object')) {
      fail(ERR.SNAPSHOT, 'snapshot.reviewEvidence invalid');
    }
  }

  function validateEvent(event) {
    if (!event || typeof event !== 'object') fail(ERR.EVENT, 'event object required');
    if (!isNonEmptyString(event.id)) fail(ERR.EVENT, 'event.id is required');
    if (!EVENT_SET.has(event.type)) fail(ERR.EVENT, `unknown event type ${event.type}`);
    // Hard safety: no event may name a protected branch as a target/branch.
    if (event.integrationTarget !== undefined && isProtectedBranch(event.integrationTarget)) {
      fail(ERR.SAFETY, `integrationTarget ${event.integrationTarget} is a protected branch`);
    }
    if (event.branch !== undefined && isProtectedBranch(event.branch)) {
      fail(ERR.SAFETY, `event.branch ${event.branch} is a protected branch`);
    }
  }

  // Returns { state, patch } for the accepted transition, or throws.
  function resolveTransition(snapshot, event) {
    const s = snapshot.state;
    const t = event.type;

    // SAFETY_VIOLATION is accepted from any non-terminal state.
    if (t === 'SAFETY_VIOLATION') {
      return { state: 'SAFETY_BLOCK', patch: {} };
    }

    if (ORCHESTRATOR_TERMINAL_STATES.includes(s)) {
      fail(ERR.TRANSITION, `state ${s} is terminal; event ${t} rejected`);
    }

    switch (`${s}:${t}`) {
      case 'TASK_READY:CLAUDE_DISPATCHED': {
        assertSha(event.baseSha, 'baseSha');
        if (event.branch !== undefined && event.branch !== snapshot.branch) {
          fail(ERR.TRANSITION, 'CLAUDE_DISPATCHED branch does not match the task branch');
        }
        return { state: 'CLAUDE_WORKING', patch: { baseSha: event.baseSha } };
      }

      case 'CLAUDE_WORKING:CLAUDE_READY_FOR_CI': {
        assertSha(event.headSha, 'headSha');
        const patch = { headSha: event.headSha };
        if (event.prNumber !== undefined) {
          if (!Number.isInteger(event.prNumber)) fail(ERR.EVENT, 'prNumber must be an integer');
          patch.prNumber = event.prNumber;
        }
        return { state: 'CI_RUNNING', patch };
      }

      case 'CI_RUNNING:CI_GREEN': {
        assertSha(event.headSha, 'headSha');
        if (event.headSha !== snapshot.headSha) {
          fail(ERR.STALE, `CI_GREEN sha ${event.headSha} does not match head ${snapshot.headSha}`);
        }
        if (!isNonEmptyString(event.ciRunId)) fail(ERR.EVENT, 'ciRunId is required');
        return { state: 'READY_FOR_CHATGPT_REVIEW', patch: { ciRunId: event.ciRunId } };
      }

      case 'CI_RUNNING:CI_FAILED': {
        if (event.headSha !== undefined && event.headSha !== snapshot.headSha) {
          fail(ERR.STALE, `CI_FAILED sha ${event.headSha} does not match head ${snapshot.headSha}`);
        }
        if (snapshot.attempt >= maxAttempts) {
          return { state: 'UNRECOVERABLE_FAILURE', patch: {} };
        }
        return { state: 'CLAUDE_WORKING', patch: { attempt: snapshot.attempt + 1, ciRunId: null } };
      }

      case 'CI_RUNNING:NEW_COMMIT':
      case 'READY_FOR_CHATGPT_REVIEW:NEW_COMMIT':
      case 'APPROVED_FOR_INTEGRATION:NEW_COMMIT': {
        assertSha(event.headSha, 'headSha');
        return {
          state: 'CI_RUNNING',
          patch: { headSha: event.headSha, ciRunId: null, reviewEvidence: null },
        };
      }

      case 'READY_FOR_CHATGPT_REVIEW:REVIEW_APPROVED': {
        const evidence = evidenceForSha(event.evidence, snapshot.headSha, 'APPROVED_FOR_INTEGRATION');
        return { state: 'APPROVED_FOR_INTEGRATION', patch: { reviewEvidence: evidence } };
      }

      case 'READY_FOR_CHATGPT_REVIEW:REVIEW_CHANGES_REQUIRED': {
        const evidence = evidenceForSha(event.evidence, snapshot.headSha, 'CHANGES_REQUIRED');
        return { state: 'CHANGES_REQUIRED', patch: { reviewEvidence: evidence } };
      }

      case 'READY_FOR_CHATGPT_REVIEW:REVIEW_HUMAN_REQUIRED': {
        const evidence = evidenceForSha(event.evidence, snapshot.headSha, 'HUMAN_APPROVAL_REQUIRED');
        return { state: 'HUMAN_APPROVAL_REQUIRED', patch: { reviewEvidence: evidence } };
      }

      case 'CHANGES_REQUIRED:CHANGES_ACKNOWLEDGED': {
        if (snapshot.attempt >= maxAttempts) {
          return { state: 'UNRECOVERABLE_FAILURE', patch: {} };
        }
        return {
          state: 'CLAUDE_WORKING',
          patch: { attempt: snapshot.attempt + 1, ciRunId: null, reviewEvidence: null },
        };
      }

      case 'HUMAN_APPROVAL_REQUIRED:HUMAN_APPROVAL_GRANTED': {
        const evidence = evidenceForSha(event.evidence, snapshot.headSha, 'APPROVED_FOR_INTEGRATION');
        return { state: 'APPROVED_FOR_INTEGRATION', patch: { reviewEvidence: evidence } };
      }

      case 'APPROVED_FOR_INTEGRATION:INTEGRATION_STARTED': {
        if (!isNonEmptyString(event.integrationTarget)) fail(ERR.EVENT, 'integrationTarget is required');
        if (event.integrationTarget !== snapshot.integrationBranch) {
          fail(ERR.TRANSITION, `integrationTarget ${event.integrationTarget} is not the approved P0 branch`);
        }
        if (!isNonEmptyString(snapshot.ciRunId)) {
          fail(ERR.TRANSITION, 'no CI evidence recorded for the approved head SHA');
        }
        if (!snapshot.reviewEvidence || snapshot.reviewEvidence.sha !== snapshot.headSha) {
          fail(ERR.STALE, 'review approval does not match the current head SHA');
        }
        return { state: 'INTEGRATING', patch: {} };
      }

      case 'INTEGRATING:INTEGRATION_VERIFIED':
        return { state: 'NEXT_TASK', patch: {} };

      case 'INTEGRATING:INTEGRATION_FAILED': {
        if (snapshot.attempt >= maxAttempts) {
          return { state: 'UNRECOVERABLE_FAILURE', patch: {} };
        }
        return { state: 'APPROVED_FOR_INTEGRATION', patch: { attempt: snapshot.attempt + 1 } };
      }

      case 'NEXT_TASK:NEXT_TASK_SELECTED': {
        if (!isNonEmptyString(event.taskId)) fail(ERR.EVENT, 'taskId is required');
        if (!isNonEmptyString(event.branch)) fail(ERR.EVENT, 'branch is required');
        return {
          state: 'TASK_READY',
          patch: {
            taskId: event.taskId,
            branch: event.branch,
            prNumber: null,
            baseSha: null,
            headSha: null,
            ciRunId: null,
            reviewEvidence: null,
            attempt: 1,
          },
        };
      }

      default:
        fail(ERR.TRANSITION, `no transition for ${s} + ${t}`);
        return undefined; // unreachable
    }
  }

  function transition(snapshot, event) {
    validateSnapshot(snapshot);
    validateEvent(event);

    // Idempotent replay: an event already applied is a no-op.
    if (snapshot.lastEventId !== null && event.id === snapshot.lastEventId) {
      return snapshot;
    }

    const { state: nextState, patch } = resolveTransition(snapshot, event);
    const at = now();
    const reason = isNonEmptyString(event.reason) ? event.reason : event.type;

    const history = snapshot.history
      .concat([{ state: nextState, eventId: event.id, at, reason }])
      .slice(-HISTORY_LIMIT);

    const next = {
      ...snapshot,
      ...patch,
      state: nextState,
      updatedAt: at,
      reason,
      lastEventId: event.id,
      history,
    };

    validateSnapshot(next);
    return deepFreeze(next);
  }

  return Object.freeze({
    integrationBranch,
    maxAttempts,
    createInitialSnapshot,
    validateSnapshot,
    transition,
  });
}
