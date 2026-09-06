// Persistent reconciliation loop for the ALGOBOT autonomous orchestrator
// (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Composition only — it wires Tasks 1-7 together and holds NO authoritative
// local state. Every tick rebuilds the actionable state from reconcile()
// (canonical GitHub evidence). Every GitHub mutation goes through the injected
// `mutators`, each call wrapped in lease.guardMutation(fenceToken, ...), so a
// fenced-out instance or a lost lease can change nothing, and a transient
// reconcile error never advances state. No business or safety logic is
// duplicated in scripts/run-autonomous-orchestrator.mjs.

import { isProtectedBranch } from './autonomous-orchestrator-state.mjs';
import { planIntegrationCycle } from './autonomous-integration-gate.mjs';

const ERR = Object.freeze({
  SAFETY: 'ORCHESTRATOR_SAFETY_VIOLATION',
  INPUT: 'ORCHESTRATOR_LOOP_INVALID_INPUT',
});

const LEASE_LOST_RE = /LEASE_LOST|STALE_FENCE|LEASE_EXPIRED|LEASE_NOT_HELD/;
const TRANSIENT_RE = /RECONCILE_FAILED|ETIMEDOUT|ENOTFOUND|ECONNRESET|network|rate limit|502|503|504/i;

const STOP_ACTIONS = new Set([
  'STOP_SAFETY',
  'STOP_UNRECOVERABLE',
  'STOP_HUMAN',
  'STOP_LIVE_GATE',
  'STOP_NO_INDEPENDENT_REVIEW',
  'STOP_PERMISSION',
  'BACKLOG_EXHAUSTED',
]);

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
}

export function createOrchestratorLoop(config = {}) {
  const {
    integrationBranch,
    lease,
    fenceToken,
    reconcile,
    evaluateCi,
    reviewGate,
    dispatchClaude,
    planContext,
    mutators = {},
    logger = () => {},
    now = () => new Date().toISOString(),
  } = config;

  if (typeof integrationBranch !== 'string' || !integrationBranch.trim()) {
    fail(ERR.INPUT, 'integrationBranch is required');
  }
  if (isProtectedBranch(integrationBranch)) {
    fail(ERR.SAFETY, `integrationBranch ${integrationBranch} is a protected branch`);
  }

  let stopped = false;

  async function guarded(fn) {
    if (typeof lease?.guardMutation === 'function') return lease.guardMutation(fenceToken, fn);
    if (typeof lease?.assertLease === 'function') { await lease.assertLease(fenceToken); }
    return fn();
  }

  async function loadPlanContext() {
    if (typeof planContext !== 'function') return { plan: { tasks: [] }, completedGates: [] };
    try {
      const ctx = await planContext();
      return {
        plan: ctx && ctx.plan ? ctx.plan : { tasks: [] },
        completedGates: ctx && Array.isArray(ctx.completedGates) ? ctx.completedGates : [],
      };
    } catch {
      return { plan: { tasks: [] }, completedGates: [] };
    }
  }

  async function gatherCi(reconciled) {
    if (typeof evaluateCi !== 'function') return null;
    if (!['CI_RUNNING', 'APPROVED_FOR_INTEGRATION'].includes(reconciled.derivedState)) return null;
    return evaluateCi(reconciled.headSha, reconciled);
  }

  async function gatherReview(reconciled) {
    if (!['READY_FOR_CHATGPT_REVIEW', 'APPROVED_FOR_INTEGRATION'].includes(reconciled.derivedState)) return null;
    if (!reviewGate || reviewGate.configured === false) {
      return { status: 'NO_INDEPENDENT_REVIEWER', failClosed: true };
    }
    try {
      return await reviewGate.fetchReviewOutcome(reconciled.reviewRequestId ?? 'pending', reconciled.headSha);
    } catch (error) {
      // A verdict signed by a self / Claude-like identity is a real safety
      // problem — surface it. A stale-SHA or malformed verdict is simply "no
      // usable review yet"; keep waiting rather than crashing the daemon.
      if (/SELF_SUBSTITUTION/.test(error.message)) throw error;
      if (/STALE_EVIDENCE/.test(error.message)) return { status: 'STALE', reason: 'REVIEW_STALE_FOR_HEAD' };
      return { status: 'PENDING' };
    }
  }

  async function executeDecision(decision, reconciled) {
    switch (decision.action) {
      case 'INTEGRATE':
        if (isProtectedBranch(decision.target)) fail(ERR.SAFETY, 'integration target is a protected branch');
        await guarded(() => mutators.integratePr({
          prNumber: reconciled.pr ? reconciled.pr.number : null,
          headSha: reconciled.headSha,
          target: decision.target,
        }));
        break;
      case 'DISPATCH_CLAUDE':
      case 'RETURN_TO_CLAUDE':
        if (typeof dispatchClaude === 'function') {
          await guarded(() => dispatchClaude({ reconciled, mode: decision.action }));
        }
        break;
      case 'RECORD_APPROVAL':
        if (typeof mutators.recordApproval === 'function') {
          await guarded(() => mutators.recordApproval({ headSha: reconciled.headSha }));
        }
        break;
      case 'AWAIT_OR_REQUEST_REVIEW':
        if (reviewGate && reviewGate.configured !== false && reconciled.pr && reconciled.headSha
          && typeof mutators.recordReviewRequest === 'function') {
          await guarded(async () => {
            const req = await reviewGate.requestIndependentReview({
              repo: reconciled.repo,
              prNumber: reconciled.pr.number,
              headSha: reconciled.headSha,
              diffScope: reconciled.diffScope ?? [],
              acceptanceCriteria: reconciled.acceptanceCriteria ?? 'See task packet.',
              ciEvidence: { runId: reconciled.evidence?.ci?.runId ?? 'unknown', sha: reconciled.headSha },
              priorFindings: reconciled.priorFindings ?? [],
            });
            await mutators.recordReviewRequest(req);
          });
        }
        break;
      case 'SELECT_NEXT_TASK':
        if (typeof mutators.recordNextTask === 'function') {
          await guarded(() => mutators.recordNextTask({ taskId: decision.taskId }));
        }
        break;
      default:
        // AWAIT_*, STOP_* and RECORD-only states perform no mutation here.
        break;
    }
  }

  async function runOnce() {
    // 1. Fence guard — a fenced-out loop must do nothing at all, not even status.
    try {
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
      return Object.freeze({
        status: transient ? 'TRANSIENT_ERROR' : 'ERROR',
        retry: transient,
        action: null,
        error: error.message,
      });
    }

    if (isProtectedBranch(reconciled.integrationBranch)) {
      fail(ERR.SAFETY, `reconciled.integrationBranch ${reconciled.integrationBranch} is a protected branch`);
    }

    // 3. Gather the exact-SHA CI / review context for the current state.
    const ciGate = await gatherCi(reconciled);
    const reviewOutcome = await gatherReview(reconciled);
    const { plan, completedGates } = await loadPlanContext();

    // 4. Pure decision.
    const decision = planIntegrationCycle({
      reconciled,
      ciGate,
      reviewOutcome,
      plan,
      completedGates,
      integrationBranch,
    });

    // 5. Structured, secret-free status.
    if (typeof mutators.postStatus === 'function') {
      try {
        await mutators.postStatus({
          state: reconciled.derivedState,
          action: decision.action,
          taskId: reconciled.taskId ?? null,
          prNumber: reconciled.pr ? reconciled.pr.number : null,
          headSha: reconciled.headSha ?? null,
          ciOutcome: ciGate ? ciGate.outcome : null,
          reviewStatus: reviewOutcome ? reviewOutcome.status : null,
          at: now(),
        });
      } catch (error) {
        logger({ level: 'warn', msg: 'postStatus failed', error: error.message });
      }
    }

    // 6. Execute (all mutations fenced).
    await executeDecision(decision, reconciled);

    return Object.freeze({
      status: 'OK',
      action: decision.action,
      state: reconciled.derivedState,
      decision,
      reconciled,
    });
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
      if (last && last.action && STOP_ACTIONS.has(last.action)) {
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
