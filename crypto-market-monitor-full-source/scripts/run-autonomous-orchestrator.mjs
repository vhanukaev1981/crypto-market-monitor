#!/usr/bin/env node
// Persistent entrypoint for the ALGOBOT autonomous orchestrator daemon.
//
// This file is DELIBERATELY thin: it wires adapters and process signals, then
// hands control to createOrchestratorLoop (algo/autonomous-orchestrator-loop.mjs).
// No business or safety decision lives here — all of that is in the composed
// Task 1-7 modules.
//
// Rollout (spec Phase 1): the default mode is --dry-run with synthetic,
// side-effect-free adapters and NO production merge. Live adapters and
// autonomous integration into agent/algobot-p0-persistent-recovery are only
// enabled once the Task 9 acceptance suite and the Task 10 deployment smoke
// gate are GREEN.

import process from 'node:process';
import { createOrchestratorLoop } from '../algo/autonomous-orchestrator-loop.mjs';
import { isProtectedBranch } from '../algo/autonomous-orchestrator-state.mjs';

const DEFAULT_INTEGRATION_BRANCH = 'agent/algobot-p0-persistent-recovery';

function flag(name) {
  return process.argv.includes(name);
}
function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

function emit(record) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

// --- Synthetic dry-run adapters: observable, never touch GitHub/Bybit ---------
function dryRunAdapters(integrationBranch) {
  let fence = 1;
  const store = { state: null };
  return {
    lease: {
      async acquireLease() { store.state = { holderId: 'dry-run', fenceToken: fence, state: 'HELD' }; return { fenceToken: fence }; },
      async renewLease(token) { if (token !== fence) throw new Error('ORCHESTRATOR_STALE_FENCE'); return { fenceToken: fence }; },
      async adoptLease() { if (!store.state) throw new Error('ORCHESTRATOR_LEASE_NOT_HELD'); return { fenceToken: fence }; },
      async assertLease(token) { if (token !== fence) throw new Error('ORCHESTRATOR_STALE_FENCE'); return true; },
      async guardMutation(token, fn) { if (token !== fence) throw new Error('ORCHESTRATOR_STALE_FENCE'); return fn(); },
      async releaseLease() { store.state = null; },
    },
    fenceToken: fence,
    bootstrap: {
      repository: process.env.ALGOBOT_REPO || 'vhanukaev1981/crypto-market-monitor',
      taskId: 'dry-run-bootstrap',
      branch: 'agent/claude-dry-run',
    },
    reconcile: async () => ({
      derivedState: 'CLAUDE_WORKING',
      headSha: null,
      integrationBranch,
      pr: null,
      reasons: ['DRY_RUN_NO_REMOTE_STATE'],
    }),
    evaluateCi: async () => ({ outcome: 'WAIT' }),
    reviewGate: { configured: false, async requestIndependentReview() { return { status: 'NO_INDEPENDENT_REVIEWER', failClosed: true }; }, async fetchReviewOutcome() { return { status: 'NO_INDEPENDENT_REVIEWER', failClosed: true }; } },
    dispatchClaude: async ({ mode }) => { emit({ level: 'info', msg: 'dry-run dispatchClaude', mode }); return { completion: 'BLOCKED', reason: 'DRY_RUN' }; },
    planContext: async () => ({ plan: { tasks: [] }, completedGates: [] }),
    mutators: {
      async integratePr(a) { emit({ level: 'warn', msg: 'dry-run integratePr (suppressed)', args: a }); },
      async recordReviewRequest(a) { emit({ level: 'info', msg: 'dry-run recordReviewRequest', args: a }); },
      async recordApproval(a) { emit({ level: 'info', msg: 'dry-run recordApproval', args: a }); },
      async recordNextTask(a) { emit({ level: 'info', msg: 'dry-run recordNextTask', args: a }); },
      async postStatus(a) { emit({ level: 'status', ...a }); },
    },
    logger: (r) => emit(r),
  };
}

// --- Live adapters: not provisioned in this task; fail closed ----------------
function liveAdapters() {
  throw new Error(
    'ORCHESTRATOR_LIVE_ADAPTERS_NOT_PROVISIONED: live GitHub / review / Claude adapters '
    + 'are wired during Task 10 controlled deployment. Run with --dry-run until then.',
  );
}

async function main() {
  const integrationBranch = opt('--integration-branch', process.env.ALGOBOT_INTEGRATION_BRANCH || DEFAULT_INTEGRATION_BRANCH);
  if (isProtectedBranch(integrationBranch)) {
    emit({ level: 'fatal', msg: 'refusing to run: integration branch is protected', integrationBranch });
    process.exitCode = 2;
    return;
  }

  const live = flag('--live');
  const adapters = live ? liveAdapters() : dryRunAdapters(integrationBranch);

  // Acquire the lease FIRST so the loop is constructed with the fence token that
  // acquisition actually returned — a takeover of a released / expired lease can
  // increment it (ChatGPT PR #19 review, Codex P1).
  let fenceToken = adapters.fenceToken;
  if (typeof adapters.lease.acquireLease === 'function') {
    try {
      const held = await adapters.lease.acquireLease();
      if (held && held.fenceToken) fenceToken = held.fenceToken;
    } catch (e) {
      emit({ level: 'fatal', msg: 'lease acquisition failed', error: e.message });
      process.exitCode = 3;
      return;
    }
  }

  const loop = createOrchestratorLoop({ integrationBranch, ...adapters, fenceToken });

  if (flag('--once')) {
    const r = await loop.runOnce();
    emit({ level: 'result', ...r });
    return;
  }

  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { emit({ level: 'info', msg: `received ${sig}, shutting down` }); ac.abort(); });
  }
  const intervalMs = Number(opt('--interval-ms', process.env.ALGOBOT_ORCHESTRATOR_INTERVAL_MS || '30000'));
  emit({ level: 'info', msg: 'orchestrator loop starting', integrationBranch, mode: live ? 'live' : 'dry-run', intervalMs });
  const summary = await loop.run({ signal: ac.signal, intervalMs });
  emit({ level: 'info', msg: 'orchestrator loop exited', ...summary });
}

main().catch((error) => {
  emit({ level: 'fatal', msg: 'orchestrator crashed', error: error && error.message ? error.message : String(error) });
  process.exitCode = 1;
});
