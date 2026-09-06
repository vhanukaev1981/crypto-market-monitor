// CI exact-SHA gate and bounded retry policy for the ALGOBOT autonomous
// orchestrator (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Pure classifier. A required check-run only counts when its headSha matches the
// PR head exactly, so a GREEN run left over from an older commit can never open
// the gate. Deterministic test failures return the task to Claude; transient
// infrastructure failures wait for a bounded retry; repeated failure past the
// attempt budget escalates to UNRECOVERABLE_FAILURE instead of looping forever.
// The gate never broadens permissions.

const ERR = 'ORCHESTRATOR_CI_GATE_INVALID_INPUT';

const OUTCOME = Object.freeze({
  GREEN: 'GREEN',
  WAIT: 'WAIT',
  RETURN_TO_CLAUDE: 'RETURN_TO_CLAUDE',
  UNRECOVERABLE_FAILURE: 'UNRECOVERABLE_FAILURE',
});

const PASS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const DETERMINISTIC_FAIL_CONCLUSIONS = new Set(['failure', 'action_required']);
// Everything else on a completed run (cancelled, timed_out, stale, null, ...)
// is treated as a transient infrastructure failure.

function fail(detail) {
  throw new Error(`${ERR}: ${detail}`);
}

function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value.trim());
}

function runOrderKey(r) {
  return r.completedAt || r.startedAt || r.updatedAt || '';
}

// Authoritative "which run is newer": by completion/start timestamp, then by
// numeric run id, then by string run id. Never by array position.
function laterRun(a, b) {
  const ka = runOrderKey(a);
  const kb = runOrderKey(b);
  if (ka !== kb) return ka > kb ? a : b;
  const na = Number(a.runId);
  const nb = Number(b.runId);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na > nb ? a : b;
  return String(a.runId ?? '') >= String(b.runId ?? '') ? a : b;
}

function classifyCheck(name, headSha, runs) {
  const forHead = runs.filter((r) => r && r.name === name && r.headSha === headSha);
  const anyForCheck = runs.some((r) => r && r.name === name);

  if (forHead.length === 0) {
    return { name, status: 'missing', staleElsewhere: anyForCheck };
  }
  const latest = forHead.reduce(laterRun);
  if (latest.status !== 'completed') {
    return { name, status: 'pending', conclusion: latest.conclusion ?? null };
  }
  if (PASS_CONCLUSIONS.has(latest.conclusion)) {
    return { name, status: 'pass', conclusion: latest.conclusion };
  }
  if (DETERMINISTIC_FAIL_CONCLUSIONS.has(latest.conclusion)) {
    return { name, status: 'deterministic_fail', conclusion: latest.conclusion };
  }
  return { name, status: 'transient_fail', conclusion: latest.conclusion ?? null };
}

export function evaluateCiGate(input = {}) {
  const {
    headSha,
    requiredChecks,
    runs,
    attempt,
    maxAttempts = 3,
    maxTransientRetries = maxAttempts,
  } = input;

  if (!isFullSha(headSha)) fail('headSha must be a full 40-hex commit SHA');
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0
    || requiredChecks.some((c) => typeof c !== 'string' || !c.trim())) {
    fail('requiredChecks must be a non-empty array of names');
  }
  if (!Array.isArray(runs)) fail('runs must be an array');
  if (!Number.isInteger(attempt) || attempt < 1) fail('attempt must be a positive integer');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) fail('maxAttempts must be a positive integer');

  const checks = requiredChecks.map((name) => classifyCheck(name, headSha, runs));
  const reasons = [];

  if (checks.some((c) => c.status === 'missing' && c.staleElsewhere)) {
    reasons.push('STALE_RUN_IGNORED');
  }

  const hasDeterministicFail = checks.some((c) => c.status === 'deterministic_fail');
  const hasTransientFail = checks.some((c) => c.status === 'transient_fail');
  const hasPendingOrMissing = checks.some((c) => c.status === 'pending' || c.status === 'missing');

  let outcome;
  let retry = false;

  if (hasDeterministicFail) {
    reasons.push('DETERMINISTIC_CHECK_FAILURE');
    outcome = attempt >= maxAttempts ? OUTCOME.UNRECOVERABLE_FAILURE : OUTCOME.RETURN_TO_CLAUDE;
  } else if (hasTransientFail) {
    reasons.push('TRANSIENT_INFRASTRUCTURE_FAILURE');
    if (attempt > maxTransientRetries) {
      outcome = OUTCOME.UNRECOVERABLE_FAILURE;
    } else {
      outcome = OUTCOME.WAIT;
      retry = true;
    }
  } else if (hasPendingOrMissing) {
    reasons.push('CHECKS_NOT_COMPLETE_ON_HEAD');
    outcome = OUTCOME.WAIT;
  } else {
    outcome = OUTCOME.GREEN;
  }

  return Object.freeze({
    outcome,
    retry,
    attempt,
    maxAttempts,
    headSha,
    reasons: Object.freeze([...new Set(reasons)]),
    checks: Object.freeze(checks.map((c) => Object.freeze({ ...c }))),
  });
}

export { OUTCOME as CI_GATE_OUTCOMES };
