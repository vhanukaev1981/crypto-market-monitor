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
import { readFile } from 'node:fs/promises';
import { createOrchestratorLoop } from '../algo/autonomous-orchestrator-loop.mjs';
import {
  isProtectedBranch,
  createOrchestratorStateMachine,
} from '../algo/autonomous-orchestrator-state.mjs';
import { createOrchestratorLease } from '../algo/autonomous-orchestrator-lease.mjs';
import { createReviewGate } from '../algo/autonomous-review-gate.mjs';
import { reconcileGithubState } from '../algo/autonomous-github-reconciler.mjs';
import { evaluateCiGate } from '../algo/autonomous-ci-gate.mjs';
import { createClaudeDispatcher } from '../algo/autonomous-claude-dispatch.mjs';
import {
  createGithubRestAdapter,
  createGithubFileLeaseStore,
  createGithubStateStore,
  createClaudeCliRunner,
  parseP0Plan,
} from '../algo/autonomous-orchestrator-adapters.mjs';

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

// --- Live adapters: real GitHub / lease / Claude / plan wiring --------------
// Autonomous INTEGRATION stays disabled unless ALGOBOT_ENABLE_P0_INTEGRATION=1
// (set only after the Task 10 host smoke gate is GREEN). Independent review is
// hard-required: with no ALGOBOT_REVIEW_* endpoint the review gate fail-closes.
async function liveAdapters(integrationBranch) {
  const repo = process.env.ALGOBOT_REPO;
  const token = process.env.ALGOBOT_GITHUB_TOKEN;
  const holderId = process.env.ALGOBOT_HOLDER_ID || `algobot-${process.pid}`;
  const claudeBranch = process.env.ALGOBOT_CLAUDE_BRANCH || 'agent/claude-p0-current';
  const requiredChecks = (process.env.ALGOBOT_REQUIRED_CHECKS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const planPath = process.env.ALGOBOT_P0_PLAN_PATH || 'docs/superpowers/plans/2026-09-05-algobot-p0-production-architecture.md';
  const enableIntegration = process.env.ALGOBOT_ENABLE_P0_INTEGRATION === '1';

  if (!repo || !token) {
    throw new Error('ORCHESTRATOR_LIVE_ADAPTERS_NOT_PROVISIONED: set ALGOBOT_REPO and ALGOBOT_GITHUB_TOKEN');
  }

  const gh = createGithubRestAdapter({ repo, token });
  const leaseStore = createGithubFileLeaseStore({ repo, token });
  const stateStore = createGithubStateStore({ repo, token });
  const lease = createOrchestratorLease({ store: leaseStore, holderId, ttlMs: Number(process.env.ALGOBOT_LEASE_TTL_MS || 300000), now: () => Date.now() });
  const held = await lease.acquireLease();

  // Independent review client — only if explicitly configured; otherwise the
  // gate is unconfigured and the loop fail-closes at READY_FOR_CHATGPT_REVIEW.
  let reviewClient = null;
  if (process.env.ALGOBOT_REVIEW_ENDPOINT && process.env.ALGOBOT_REVIEW_TOKEN) {
    const ep = process.env.ALGOBOT_REVIEW_ENDPOINT;
    const rt = process.env.ALGOBOT_REVIEW_TOKEN;
    reviewClient = {
      reviewerId: process.env.ALGOBOT_REVIEWER_ID || 'chatgpt-independent-reviewer',
      async submitReviewRequest(packet) {
        const res = await fetch(`${ep}/requests`, { method: 'POST', headers: { Authorization: `Bearer ${rt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(packet) });
        if (!res.ok) throw new Error(`review submit ${res.status}`);
        return res.json();
      },
      async fetchReviewOutcome(requestId) {
        const res = await fetch(`${ep}/requests/${encodeURIComponent(requestId)}`, { headers: { Authorization: `Bearer ${rt}` } });
        if (res.status === 404 || res.status === 204) return null;
        if (!res.ok) throw new Error(`review fetch ${res.status}`);
        return res.json();
      },
    };
  }
  const reviewGate = createReviewGate({ reviewClient });

  const dispatcher = createClaudeDispatcher({ runProcess: createClaudeCliRunner({ claudeBin: process.env.ALGOBOT_CLAUDE_BIN || 'claude' }) });

  const task = { id: process.env.ALGOBOT_CURRENT_TASK_ID || 'p0-current', branch: claudeBranch, requiredChecks };

  const suppressedIntegrate = async (a) => { emit({ level: 'warn', msg: 'integration disabled (ALGOBOT_ENABLE_P0_INTEGRATION!=1)', args: a }); };

  return {
    lease,
    fenceToken: held.fenceToken,
    stateMachine: createOrchestratorStateMachine({ integrationBranch }),
    stateStore,
    bootstrap: { repository: repo, taskId: task.id, branch: claudeBranch },
    reconcile: () => reconcileGithubState({ repo, integrationBranch, task, github: gh, integrationLedger: gh.integrationLedger }),
    evaluateCi: (headSha, attempt) => Promise.resolve(gh.getCiStatus(headSha, requiredChecks)).then(async () => {
      const runsRes = await gh.getCiStatus(headSha, requiredChecks);
      return evaluateCiGate({ headSha, requiredChecks: requiredChecks.length ? requiredChecks : ['ci'], runs: [{ name: (requiredChecks[0] || 'ci'), headSha, status: runsRes.state === 'PENDING' || runsRes.state === 'NONE' ? 'in_progress' : 'completed', conclusion: runsRes.state === 'GREEN' ? 'success' : runsRes.state === 'FAILED' ? 'failure' : null, runId: runsRes.runId }], attempt: attempt || 1 });
    }),
    reviewGate,
    dispatchClaude: ({ reconciled, attempt }) => dispatcher.dispatchClaudeTask({
      task,
      baseSha: reconciled.headSha || process.env.ALGOBOT_BASE_SHA || '0'.repeat(40),
      branch: claudeBranch,
      acceptanceCriteria: 'See the approved P0 plan for this task.',
      constraints: ['NO_MERGE_TO_MAIN', 'NO_REAL_BYBIT_ORDER', 'PRESERVE_CANARY_LIMITS', 'STRICT_RED_GREEN_TDD'],
      attempt: attempt || 1,
    }),
    planContext: async () => {
      const md = await readFile(new URL(`../../${planPath}`, import.meta.url), 'utf8').catch(() => readFile(planPath, 'utf8'));
      const plan = parseP0Plan(md);
      const completedGates = [];
      for (const t of plan.tasks) {
        if (t.status === 'DONE' || await gh.integrationLedger.hasIntegratedTask(t.id)) completedGates.push(t.id);
      }
      return { plan, completedGates };
    },
    mutators: {
      ...gh.mutators,
      integratePr: enableIntegration ? gh.mutators.integratePr : suppressedIntegrate,
    },
    logger: (r) => emit(r),
  };
}

async function main() {
  const integrationBranch = opt('--integration-branch', process.env.ALGOBOT_INTEGRATION_BRANCH || DEFAULT_INTEGRATION_BRANCH);
  if (isProtectedBranch(integrationBranch)) {
    emit({ level: 'fatal', msg: 'refusing to run: integration branch is protected', integrationBranch });
    process.exitCode = 2;
    return;
  }

  const live = flag('--live');
  let adapters;
  try {
    // Live adapters acquire the lease internally and return the fence token that
    // acquisition produced (a takeover can increment it — Codex P1). The dry-run
    // path acquires below.
    adapters = live ? await liveAdapters(integrationBranch) : dryRunAdapters(integrationBranch);
  } catch (e) {
    emit({ level: 'fatal', msg: 'adapter wiring failed', error: e.message });
    process.exitCode = 3;
    return;
  }

  let fenceToken = adapters.fenceToken;
  if (!live && typeof adapters.lease.acquireLease === 'function') {
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
