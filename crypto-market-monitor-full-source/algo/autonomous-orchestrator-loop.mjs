// Persistent reconciliation loop for the ALGOBOT autonomous orchestrator
// (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Composition of Tasks 1-7. GitHub evidence (reconcile()) is canonical for
// "where are we"; the injected state machine + durable state store add the
// canonical overlay the daemon needs: a persisted attempt counter, event-id
// deduplication, the independent-review request id, and a transition audit
// trail — all of which must survive a restart. Every GitHub mutation runs
// through `mutators` inside lease.guardMutation(fenceToken, ...), the lease is
// renewed each tick, and a lost lease, a permission failure, a malformed /
// unauthorised review, or a plan-load failure all STOP the daemon fail-closed.
// No business or safety logic is duplicated in the systemd entrypoint.

import {
  isProtectedBranch,
  createOrchestratorStateMachine,
} from './autonomous-orchestrator-state.mjs';
import { planIntegrationCycle } from './autonomous-integration-gate.mjs';

const ERR = Object.freeze({
  SAFETY: 'ORCHESTRATOR_SAFETY_VIOLATION',
  INPUT: 'ORCHESTRATOR_LOOP_INVALID_INPUT',
  PERMISSION: 'ORCHESTRATOR_LOOP_PERMISSION',
});

const LEASE_LOST_RE = /LEASE_LOST|STALE_FENCE|LEASE_EXPIRED|LEASE_NOT_HELD/;
const TRANSIENT_RE = /RECONCILE_FAILED|ETIMEDOUT|ENOTFOUND|ECONNRESET|network|rate limit|502|503|504/i;
const PERMISSION_RE = /\b403\b|permission|denied|not accessible|forbidden|unauthor/i;
const SELF_SUB_RE = /SELF_SUBSTITUTION/;
const REVIEW_MALFORMED_RE = /MALFORMED_VERDICT|MALFORMED/;
const REVIEW_STALE_RE = /STALE_EVIDENCE/;

const STOP_ACTIONS = new Set([
  'STOP_SAFETY',
  'STOP_UNRECOVERABLE',
  'STOP_HUMAN',
  'STOP_LIVE_GATE',
  'STOP_NO_INDEPENDENT_REVIEW',
  'STOP_REVIEW_MALFORMED',
  'STOP_REVIEW_ERROR',
  'STOP_PLAN_UNAVAILABLE',
  'STOP_PERMISSION',
  'STOP_STATE_UNAVAILABLE',
  'STOP_STATE_INVALID',
  'STOP_STATE_PERSIST_FAILED',
  'BACKLOG_EXHAUSTED',
]);

// Linear happy-path order used only to SYNC the durable snapshot forward to the
// reconciled GitHub state. Retry / branch transitions are handled explicitly.
const LINEAR_ORDER = [
  'TASK_READY',
  'CLAUDE_WORKING',
  'CI_RUNNING',
  'READY_FOR_CHATGPT_REVIEW',
  'APPROVED_FOR_INTEGRATION',
  'INTEGRATING',
  'NEXT_TASK',
];

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function inMemoryStateStore() {
  let blob = null;
  return {
    async load() { return blob ? JSON.parse(JSON.stringify(blob)) : null; },
    async save(next) { blob = JSON.parse(JSON.stringify(next)); },
  };
}

export function createOrchestratorLoop(config = {}) {
  const {
    integrationBranch,
    lease,
    fenceToken: initialFenceToken,
    reconcile,
    evaluateCi,
    reviewGate,
    dispatchClaude,
    planContext,
    mutators = {},
    logger = () => {},
    now = () => new Date().toISOString(),
    stateMachine = null,
    stateStore = inMemoryStateStore(),
    bootstrap = {},
    renewLease: renewLeaseEnabled = true,
    maxAttempts = 3,
  } = config;

  if (typeof integrationBranch !== 'string' || !integrationBranch.trim()) {
    fail(ERR.INPUT, 'integrationBranch is required');
  }
  if (isProtectedBranch(integrationBranch)) {
    fail(ERR.SAFETY, `integrationBranch ${integrationBranch} is a protected branch`);
  }

  const machine = stateMachine
    || createOrchestratorStateMachine({ integrationBranch, maxAttempts });

  let stopped = false;
  let fenceToken = initialFenceToken;

  // --- durable snapshot + runtime extras -----------------------------------

  function bootstrapSnapshot(reconciled) {
    const repository = bootstrap.repository
      || (typeof reconciled.repo === 'string' && reconciled.repo.includes('/') ? reconciled.repo : null)
      || 'algobot/orchestrator';
    const taskId = bootstrap.taskId || reconciled.taskId || 'bootstrap-task';
    let branch = bootstrap.branch || reconciled.branch || 'agent/claude-bootstrap';
    if (isProtectedBranch(branch)) branch = 'agent/claude-bootstrap';
    return machine.createInitialSnapshot({ repository, taskId, branch });
  }

  async function loadPersisted(reconciled) {
    let blob;
    try {
      blob = await stateStore.load();
    } catch (error) {
      // An IO / auth failure reading canonical state is NOT "no state" — stop.
      return { error: 'UNAVAILABLE', message: error.message };
    }
    const runtime = (blob && blob.runtime && typeof blob.runtime === 'object')
      ? { reviewRequestId: null, reviewRequestSha: null, pendingReviewFor: null, ...blob.runtime }
      : { reviewRequestId: null, reviewRequestSha: null, pendingReviewFor: null };
    if (blob && blob.snapshot) {
      try {
        machine.validateSnapshot(blob.snapshot);
        return { snapshot: blob.snapshot, runtime };
      } catch (error) {
        // A persisted-but-invalid snapshot must not be silently reset.
        return { error: 'INVALID', message: error.message };
      }
    }
    return { snapshot: bootstrapSnapshot(reconciled), runtime };
  }

  async function persist(snapshot, runtime) {
    // A failure to persist canonical state must STOP the tick, not be swallowed.
    await stateStore.save({ snapshot, runtime });
  }

  // --- snapshot forward-sync + retry overlay ------------------------------

  function forwardEvent(nextState, reconciled, snapshot) {
    const sha = reconciled.headSha;
    switch (nextState) {
      case 'CLAUDE_WORKING':
        return sha ? { id: `dispatched:${snapshot.branch}:${sha}`, type: 'CLAUDE_DISPATCHED', baseSha: sha } : null;
      case 'CI_RUNNING':
        return sha ? { id: `readyci:${sha}`, type: 'CLAUDE_READY_FOR_CI', headSha: sha } : null;
      case 'READY_FOR_CHATGPT_REVIEW':
        return sha ? {
          id: `cigreen:${sha}`, type: 'CI_GREEN', headSha: sha,
          ciRunId: (reconciled.evidence && reconciled.evidence.ci && reconciled.evidence.ci.runId) || 'observed',
        } : null;
      case 'APPROVED_FOR_INTEGRATION':
        return sha ? {
          id: `approved:${sha}`, type: 'REVIEW_APPROVED',
          evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha, reviewerId: 'observed-independent' },
        } : null;
      case 'INTEGRATING':
        return { id: `integstart:${sha || ''}`, type: 'INTEGRATION_STARTED', integrationTarget: integrationBranch };
      case 'NEXT_TASK':
        return { id: `integverified:${sha || ''}`, type: 'INTEGRATION_VERIFIED' };
      default:
        return null;
    }
  }

  function syncForward(snapshot, reconciled) {
    const targetIdx = LINEAR_ORDER.indexOf(reconciled.derivedState);
    if (targetIdx < 0) return snapshot; // CHANGES_REQUIRED / HUMAN / SAFETY handled elsewhere
    let curIdx = LINEAR_ORDER.indexOf(snapshot.state);
    while (curIdx >= 0 && curIdx < targetIdx) {
      const ev = forwardEvent(LINEAR_ORDER[curIdx + 1], reconciled, snapshot);
      if (!ev) break;
      try {
        const next = machine.transition(snapshot, ev);
        if (next === snapshot && next.state === LINEAR_ORDER[curIdx]) {
          // event was deduped and did not advance — stop syncing.
          break;
        }
        snapshot = next;
      } catch {
        break; // an illegal/stale sync event: leave the snapshot where it is.
      }
      curIdx = LINEAR_ORDER.indexOf(snapshot.state);
    }
    return snapshot;
  }

  function applyRetryOverlay(snapshot, reconciled, ciGate) {
    if (reconciled.derivedState === 'CI_RUNNING'
      && ciGate && ciGate.outcome === 'RETURN_TO_CLAUDE'
      && snapshot.state === 'CI_RUNNING') {
      const ev = {
        id: `cifail:${reconciled.headSha}:${ciGate.runId || ''}`,
        type: 'CI_FAILED',
        headSha: reconciled.headSha,
      };
      try { snapshot = machine.transition(snapshot, ev); } catch { /* stale sha etc. */ }
    }
    if (reconciled.derivedState === 'CHANGES_REQUIRED') {
      // sync READY -> CHANGES_REQUIRED, then acknowledge (attempt++ / escalate)
      if (snapshot.state === 'READY_FOR_CHATGPT_REVIEW' && reconciled.headSha) {
        try {
          snapshot = machine.transition(snapshot, {
            id: `changes:${reconciled.headSha}`, type: 'REVIEW_CHANGES_REQUIRED',
            evidence: { verdict: 'CHANGES_REQUIRED', sha: reconciled.headSha, reviewerId: 'observed-independent' },
          });
        } catch { /* not in READY */ }
      }
      if (snapshot.state === 'CHANGES_REQUIRED') {
        try {
          snapshot = machine.transition(snapshot, {
            id: `chgack:${reconciled.headSha}`, type: 'CHANGES_ACKNOWLEDGED',
          });
        } catch { /* noop */ }
      }
    }
    return snapshot;
  }

  // --- context gathering -------------------------------------------------

  async function loadPlanContextSafe() {
    if (typeof planContext !== 'function') return { plan: { tasks: [] }, completedGates: [] };
    try {
      const ctx = await planContext();
      return {
        plan: ctx && ctx.plan ? ctx.plan : { tasks: [] },
        completedGates: ctx && Array.isArray(ctx.completedGates) ? ctx.completedGates : [],
      };
    } catch (error) {
      return { error: true, message: error.message };
    }
  }

  async function gatherCi(reconciled, attempt) {
    if (typeof evaluateCi !== 'function') return null;
    if (!['CI_RUNNING', 'APPROVED_FOR_INTEGRATION'].includes(reconciled.derivedState)) return null;
    return evaluateCi(reconciled.headSha, attempt, reconciled);
  }

  async function gatherReview(reconciled, runtime) {
    if (!['READY_FOR_CHATGPT_REVIEW', 'APPROVED_FOR_INTEGRATION'].includes(reconciled.derivedState)) return null;
    if (!reviewGate || reviewGate.configured === false) {
      return { status: 'NO_INDEPENDENT_REVIEWER', failClosed: true };
    }
    const requestId = (runtime.reviewRequestId && runtime.reviewRequestSha === reconciled.headSha)
      ? runtime.reviewRequestId
      : null;
    try {
      // Always ask the gate: a real client keys outcomes by PR + exact SHA and
      // can answer before we have persisted a request id (e.g. after a restart,
      // or when the reconciler already observed the verdict on GitHub).
      const outcome = await reviewGate.fetchReviewOutcome(requestId || 'pending', reconciled.headSha);
      if (outcome && ['COMPLETE', 'MALFORMED', 'ERROR', 'NO_INDEPENDENT_REVIEWER'].includes(outcome.status)) {
        return outcome;
      }
      // null / PENDING: only submit a fresh request when we have not already.
      return requestId ? { status: 'PENDING' } : { status: 'NEEDS_REQUEST' };
    } catch (error) {
      if (SELF_SUB_RE.test(error.message)) throw error; // real safety problem
      if (REVIEW_MALFORMED_RE.test(error.message)) return { status: 'MALFORMED', failClosed: true, error: error.message };
      if (REVIEW_STALE_RE.test(error.message)) return { status: 'STALE', reason: 'REVIEW_STALE_FOR_HEAD' };
      // auth / permission / unknown -> fail closed, do NOT loop silently.
      return { status: 'ERROR', failClosed: true, error: error.message };
    }
  }

  function decideReviewAction(reviewOutcome) {
    switch (reviewOutcome.status) {
      case 'NO_INDEPENDENT_REVIEWER': return { action: 'STOP_NO_INDEPENDENT_REVIEW' };
      case 'MALFORMED': return { action: 'STOP_REVIEW_MALFORMED' };
      case 'ERROR': return { action: 'STOP_REVIEW_ERROR' };
      case 'NEEDS_REQUEST': return { action: 'REQUEST_REVIEW' };
      case 'COMPLETE': {
        const v = reviewOutcome.evidence && reviewOutcome.evidence.verdict;
        if (v === 'CHANGES_REQUIRED') return { action: 'RETURN_TO_CLAUDE' };
        if (v === 'HUMAN_APPROVAL_REQUIRED') return { action: 'STOP_HUMAN' };
        if (v === 'APPROVED_FOR_INTEGRATION') return { action: 'RECORD_APPROVAL' };
        return { action: 'AWAIT_REVIEW' };
      }
      default: return { action: 'AWAIT_REVIEW' };
    }
  }

  // --- mutation execution (all fenced) ---------------------------------

  async function guardedMutation(fn) {
    if (typeof lease?.guardMutation === 'function') return lease.guardMutation(fenceToken, fn);
    if (typeof lease?.assertLease === 'function') await lease.assertLease(fenceToken);
    return fn();
  }

  async function runMutator(fn) {
    try {
      // R2: re-assert the fence IMMEDIATELY before the mutation (in addition to
      // guardMutation and the adapter's commit-time leaseCheck).
      if (typeof lease?.assertLease === 'function') await lease.assertLease(fenceToken);
      return await guardedMutation(fn);
    } catch (error) {
      if (PERMISSION_RE.test(error.message)) fail(ERR.PERMISSION, error.message);
      if (LEASE_LOST_RE.test(error.message)) fail('ORCHESTRATOR_LOOP_LEASE_LOST', error.message);
      throw error;
    }
  }

  function claudeBranchFor(taskId) {
    const s = String(taskId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `agent/claude-${s || 'task'}`;
  }

  async function executeDecision(decision, reconciled, snapshot, runtime, reviewOutcome, ctx) {
    switch (decision.action) {
      case 'INTEGRATE': {
        if (isProtectedBranch(decision.target)) fail(ERR.SAFETY, 'integration target is a protected branch');
        await runMutator(() => mutators.integratePr({
          prNumber: reconciled.pr ? reconciled.pr.number : null,
          headSha: reconciled.headSha,
          target: decision.target,
          taskId: reconciled.taskId || snapshot.taskId,
        }));
        break;
      }
      case 'DISPATCH_CLAUDE':
      case 'RETURN_TO_CLAUDE':
        if (typeof dispatchClaude === 'function') {
          await runMutator(() => dispatchClaude({ reconciled, attempt: snapshot.attempt, mode: decision.action }));
        }
        break;
      case 'RECORD_APPROVAL':
        if (typeof mutators.recordApproval === 'function') {
          const ev = reviewOutcome && reviewOutcome.evidence ? reviewOutcome.evidence : {};
          await runMutator(() => mutators.recordApproval({
            verdict: 'APPROVED_FOR_INTEGRATION',
            sha: reconciled.headSha,
            reviewerId: ev.reviewerId || null,
          }));
        }
        break;
      case 'REQUEST_REVIEW': {
        if (reviewGate && reviewGate.configured !== false && reconciled.pr && reconciled.headSha) {
          if (runtime.reviewRequestId && runtime.reviewRequestSha === reconciled.headSha) break; // already have one
          // R4: persist the INTENT before submitting, so a crash between submit
          // and id-persistence does not silently duplicate paid review work.
          runtime.pendingReviewFor = reconciled.headSha;
          if (ctx && typeof ctx.persist === 'function') await ctx.persist();
          const submitted = await runMutator(async () => {
            const out = await reviewGate.requestIndependentReview({
              repo: reconciled.repo,
              prNumber: reconciled.pr.number,
              headSha: reconciled.headSha,
              diffScope: reconciled.diffScope || [],
              acceptanceCriteria: reconciled.acceptanceCriteria || 'See task packet.',
              ciEvidence: { runId: (reconciled.evidence && reconciled.evidence.ci && reconciled.evidence.ci.runId) || 'observed', sha: reconciled.headSha },
              priorFindings: reconciled.priorFindings || [],
            });
            if (typeof mutators.recordReviewRequest === 'function') {
              await mutators.recordReviewRequest({ ...out, headSha: reconciled.headSha });
            }
            return out;
          });
          if (submitted && submitted.requestId) {
            runtime.reviewRequestId = submitted.requestId;
            runtime.reviewRequestSha = reconciled.headSha;
            if (ctx && typeof ctx.persist === 'function') await ctx.persist();
          }
        }
        break;
      }
      case 'SELECT_NEXT_TASK':
        if (typeof mutators.recordNextTask === 'function') {
          const baseSha = reconciled.integrationHead || reconciled.headSha || null;
          if (!baseSha || /^0+$/.test(baseSha)) fail(ERR.SAFETY, 'refusing next-task dispatch with an invalid base SHA');
          await runMutator(() => mutators.recordNextTask({
            taskId: decision.taskId,
            branch: claudeBranchFor(decision.taskId),
            baseSha,
          }));
        }
        break;
      default:
        break; // AWAIT_* / STOP_* / RECORD-only
    }
  }

  // --- one tick --------------------------------------------------------

  async function runOnce() {
    // 1. Renew then assert the lease — the renewal window keeps the fence
    //    current right before this tick's work.
    try {
      if (renewLeaseEnabled && typeof lease?.renewLease === 'function') {
        await lease.renewLease(fenceToken);
      }
      if (typeof lease?.assertLease === 'function') await lease.assertLease(fenceToken);
    } catch (error) {
      if (LEASE_LOST_RE.test(error.message)) {
        return Object.freeze({ status: 'LEASE_LOST', action: null, error: error.message });
      }
      throw error;
    }

    // 2. Canonical reconciliation.
    let reconciled;
    try {
      reconciled = await reconcile();
    } catch (error) {
      const transient = TRANSIENT_RE.test(error.message);
      if (typeof mutators.postStatus === 'function') {
        try { await mutators.postStatus({ state: 'RECONCILE_ERROR', action: null, at: now(), error: error.message }); } catch { /* best effort */ }
      }
      return Object.freeze({ status: transient ? 'TRANSIENT_ERROR' : 'ERROR', retry: transient, action: null, error: error.message });
    }

    if (isProtectedBranch(reconciled.integrationBranch)) {
      fail(ERR.SAFETY, `reconciled.integrationBranch ${reconciled.integrationBranch} is a protected branch`);
    }

    // 3. Durable snapshot: load, sync forward to the reconciled state, apply
    //    the retry overlay (attempt++ / escalate) through the real state machine.
    const persisted = await loadPersisted(reconciled);
    if (persisted.error === 'UNAVAILABLE') {
      return Object.freeze({ status: 'STOPPED', action: 'STOP_STATE_UNAVAILABLE', error: persisted.message });
    }
    if (persisted.error === 'INVALID') {
      return Object.freeze({ status: 'STOPPED', action: 'STOP_STATE_INVALID', error: persisted.message });
    }
    const { snapshot: loaded, runtime } = persisted;
    let snapshot = syncForward(loaded, reconciled);

    // 4. Context, using the DURABLE attempt count.
    const ciGate = await gatherCi(reconciled, snapshot.attempt);
    snapshot = applyRetryOverlay(snapshot, reconciled, ciGate);

    let reviewOutcome = null;
    try {
      reviewOutcome = await gatherReview(reconciled, runtime);
    } catch (error) {
      await persist(snapshot, runtime);
      return Object.freeze({ status: 'OK', action: 'STOP_SAFETY', state: reconciled.derivedState, error: error.message });
    }

    const planCtx = await loadPlanContextSafe();

    // 5. Decide. Escalations recorded in the snapshot win; otherwise the
    //    reconciled GitHub state drives the action.
    const escalated = ['UNRECOVERABLE_FAILURE', 'SAFETY_BLOCK'].includes(snapshot.state);
    const effectiveState = escalated ? snapshot.state : reconciled.derivedState;

    let decision;
    if (effectiveState === 'READY_FOR_CHATGPT_REVIEW' && reviewOutcome) {
      decision = decideReviewAction(reviewOutcome);
    } else if (effectiveState === 'NEXT_TASK' && planCtx.error) {
      decision = { action: 'STOP_PLAN_UNAVAILABLE' };
    } else {
      decision = planIntegrationCycle({
        reconciled: { ...reconciled, derivedState: effectiveState },
        ciGate,
        reviewOutcome,
        plan: planCtx.plan || { tasks: [] },
        completedGates: planCtx.completedGates || [],
        integrationBranch,
      });
    }

    // 6. Structured, secret-free status.
    if (typeof mutators.postStatus === 'function') {
      try {
        await mutators.postStatus({
          state: effectiveState,
          action: decision.action,
          attempt: snapshot.attempt,
          taskId: reconciled.taskId || null,
          prNumber: reconciled.pr ? reconciled.pr.number : null,
          headSha: reconciled.headSha || null,
          ciOutcome: ciGate ? ciGate.outcome : null,
          reviewStatus: reviewOutcome ? reviewOutcome.status : null,
          at: now(),
        });
      } catch (error) {
        logger({ level: 'warn', msg: 'postStatus failed', error: error.message });
      }
    }

    // 7. Persist BEFORE acting. A persist failure STOPS the tick fail-closed —
    //    the decision must never run from state we could not durably record.
    try {
      await persist(snapshot, runtime);
    } catch (error) {
      return Object.freeze({ status: 'STOPPED', action: 'STOP_STATE_PERSIST_FAILED', error: error.message });
    }

    // 8. Execute (fenced). Permission / lease failures stop the daemon.
    const ctx = { persist: () => persist(snapshot, runtime) };
    try {
      await executeDecision(decision, reconciled, snapshot, runtime, reviewOutcome, ctx);
    } catch (error) {
      try { await persist(snapshot, runtime); } catch { /* already failing */ }
      if (error.message.startsWith(ERR.PERMISSION)) {
        return Object.freeze({ status: 'STOPPED', action: 'STOP_PERMISSION', state: effectiveState, error: error.message });
      }
      if (error.message.startsWith('ORCHESTRATOR_LOOP_LEASE_LOST')) {
        return Object.freeze({ status: 'LEASE_LOST', action: null, error: error.message });
      }
      if (error.message.startsWith(ERR.SAFETY)) {
        return Object.freeze({ status: 'STOPPED', action: 'STOP_SAFETY', state: effectiveState, error: error.message });
      }
      throw error;
    }

    try { await persist(snapshot, runtime); }
    catch (error) { return Object.freeze({ status: 'STOPPED', action: 'STOP_STATE_PERSIST_FAILED', error: error.message }); }

    return Object.freeze({
      status: STOP_ACTIONS.has(decision.action) ? 'STOPPED' : 'OK',
      action: decision.action,
      state: effectiveState,
      attempt: snapshot.attempt,
      decision,
      reconciled,
    });
  }

  // --- persistent loop ------------------------------------------------

  async function tryReacquireLease() {
    try {
      if (typeof lease?.adoptLease === 'function') {
        const held = await lease.adoptLease();
        if (held && held.fenceToken) fenceToken = held.fenceToken;
        return true;
      }
    } catch { /* fall through */ }
    try {
      if (typeof lease?.acquireLease === 'function') {
        const held = await lease.acquireLease();
        if (held && held.fenceToken) fenceToken = held.fenceToken;
        return true;
      }
    } catch { /* fall through */ }
    return false;
  }

  async function run({ signal, intervalMs = 30_000, maxTicks = Infinity } = {}) {
    let ticks = 0;
    let last = null;
    while (!stopped && !(signal && signal.aborted) && ticks < maxTicks) {
      try {
        last = await runOnce();
      } catch (error) {
        last = { status: 'ERROR', action: null, error: error.message };
        logger({ level: 'error', msg: 'runOnce threw', error: error.message });
      }
      ticks += 1;

      if (last && last.status === 'LEASE_LOST') {
        const recovered = await tryReacquireLease();
        if (!recovered) {
          return Object.freeze({ status: 'STOPPED', reason: 'LEASE_LOST', ticks, last });
        }
      } else if (last && last.action && STOP_ACTIONS.has(last.action)) {
        return Object.freeze({ status: 'STOPPED', reason: last.action, ticks, last });
      }

      if (stopped || (signal && signal.aborted) || ticks >= maxTicks) break;
      await abortableDelay(intervalMs, signal);
    }
    return Object.freeze({
      status: (signal && signal.aborted) || stopped ? 'SHUTDOWN' : 'MAX_TICKS',
      ticks,
      last,
    });
  }

  function stop() { stopped = true; }

  return Object.freeze({ runOnce, run, stop, integrationBranch });
}
