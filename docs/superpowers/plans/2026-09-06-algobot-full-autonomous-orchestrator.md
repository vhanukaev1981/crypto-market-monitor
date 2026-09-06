# ALGOBOT Full Autonomous Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and acceptance-test a 24/7 fail-closed orchestrator on `algobot-bybit-01` that advances P0 tasks through Claude, GitHub Actions, independent ChatGPT review, P0 integration, and next-task dispatch without user relay.

**Architecture:** Extend the existing autonomous planner into a small deterministic state-machine core plus GitHub adapter and Claude/review dispatch adapters. GitHub evidence is canonical; the host continuously reconciles and may cache only non-authoritative cursors. External actions are exact-SHA-bound and idempotent.

**Tech Stack:** Node.js 22.13.0, ESM `.mjs`, `node:test`, GitHub Actions/API, systemd on `algobot-bybit-01`, Claude Code CLI/non-interactive interface, supported machine-invocable independent review integration.

**Spec:** `docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md`

## Global Constraints
- Automatic integration target is only `agent/algobot-p0-persistent-recovery`; never `main`.
- No real Bybit order, LIVE enablement, futures, derivatives, margin, leverage, withdrawal, transfer, or blind OOS.
- CANARY safety envelope remains $10/order and $100 cumulative.
- GitHub Actions GREEN must match the exact PR head SHA.
- Independent review approval must match the exact PR head SHA and becomes stale after a new commit.
- Missing review endpoint, permission, authentication, or inconsistent state fails closed.
- All implementation tasks use strict RED -> GREEN TDD and frequent commits.

---

### Task 1: Deterministic orchestration state machine

**Files:**
- Create: `crypto-market-monitor-full-source/algo/autonomous-orchestrator-state.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-orchestrator-state.test.mjs`

**Interfaces:**
- Produces: `createOrchestratorStateMachine({ integrationBranch })` with `transition(snapshot, event)` returning a new immutable snapshot or throwing on an invalid/safety transition.

- [ ] Write RED tests covering all canonical states, legal transitions, invalid transition rejection, duplicate event idempotency, exact SHA binding, stale approval rejection, and hard rejection of `main` as integration target.
- [ ] Run `node --test tests/algo-autonomous-orchestrator-state.test.mjs`; verify RED is caused by the missing state-machine implementation.
- [ ] Implement the minimal pure state machine. No network, filesystem, Claude, or GitHub calls belong in this file.
- [ ] Re-run the dedicated test until GREEN.
- [ ] Run existing autonomous planner/state tests to prove no regression.
- [ ] Commit test and implementation together with a Task 1 TDD evidence message.

### Task 2: Canonical GitHub reconciliation and restart recovery

**Files:**
- Create: `crypto-market-monitor-full-source/algo/autonomous-github-reconciler.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-github-reconciler.test.mjs`

**Interfaces:**
- Consumes: state-machine snapshots/events from Task 1.
- Produces: `reconcileGithubState({ repo, integrationBranch, github }) -> Promise<ReconciledState>` and exact-SHA evidence objects for PR/check/review state.

- [ ] Write RED tests with a fake GitHub adapter for restart reconstruction, stale CI GREEN, stale review approval, duplicate webhook/poll observations, missing PR, and inconsistent branch/PR state.
- [ ] Verify RED with the dedicated `node --test` command.
- [ ] Implement reconciliation so local cursor/cache is never authoritative and every actionable decision is rebuilt from GitHub evidence.
- [ ] Add crash-after-external-action fixtures proving restart does not redispatch an already recorded action.
- [ ] Run Task 1+2 tests GREEN and commit.

### Task 3: Single-active orchestrator lease/fencing

**Files:**
- Create: `crypto-market-monitor-full-source/algo/autonomous-orchestrator-lease.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-orchestrator-lease.test.mjs`

**Interfaces:**
- Produces: `acquireLease`, `renewLease`, `assertLease`, `releaseLease`; every mutating cycle requires a current fence token.

- [ ] Write RED tests for two competing orchestrators, stale fence token, lease expiry/takeover, and crash/restart.
- [ ] Verify RED.
- [ ] Implement the minimum durable lease mechanism using a host-local lock only as an optimization and a canonical GitHub-visible fence/lease record for mutation authorization.
- [ ] Prove the stale instance cannot dispatch Claude, integrate, or advance state.
- [ ] Run Task 1-3 GREEN and commit.

### Task 4: Claude non-interactive dispatch adapter

**Files:**
- Create: `crypto-market-monitor-full-source/algo/autonomous-claude-dispatch.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-claude-dispatch.test.mjs`

**Interfaces:**
- Produces: `dispatchClaudeTask({ task, baseSha, branch, acceptanceCriteria, constraints, attempt })` and parses only machine-readable completion markers.

- [ ] Write RED tests for exact base SHA, dedicated branch naming, required TDD/safety packet, malformed/free-form completion, `BLOCKED`, retry attempt metadata, and attempted `main` target.
- [ ] Verify RED without invoking a live Claude session.
- [ ] Implement command construction and completion parsing with dependency injection for process execution.
- [ ] Add a fake CLI acceptance test proving `READY_FOR_CI` is accepted and prose-only success is rejected.
- [ ] Run GREEN and commit.

### Task 5: CI exact-SHA gate and bounded retry policy

**Files:**
- Create: `crypto-market-monitor-full-source/algo/autonomous-ci-gate.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-ci-gate.test.mjs`

**Interfaces:**
- Produces: `evaluateCiGate({ headSha, requiredChecks, runs, attempt })` returning `GREEN`, `WAIT`, `RETURN_TO_CLAUDE`, or `UNRECOVERABLE_FAILURE`.

- [ ] Write RED tests for current GREEN, older-SHA GREEN, pending, transient infrastructure failure, deterministic test failure, bounded repeated identical failure, and mixed required-check results.
- [ ] Verify RED.
- [ ] Implement exact-SHA selection and bounded retry/escalation without permission broadening.
- [ ] Run GREEN plus previous orchestrator tests and commit.

### Task 6: Independent ChatGPT review adapter

**Files:**
- Create: `crypto-market-monitor-full-source/algo/autonomous-review-gate.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-review-gate.test.mjs`

**Interfaces:**
- Produces: `requestIndependentReview(packet)` and `validateReviewEvidence({ evidence, expectedSha })` accepting only `CHANGES_REQUIRED`, `APPROVED_FOR_INTEGRATION`, or `HUMAN_APPROVAL_REQUIRED`.

- [ ] Write RED tests for exact-SHA review packet, stale approval, malformed verdict, missing endpoint/configuration, self-review substitution, changes-required feedback, and human gate.
- [ ] Verify RED.
- [ ] Implement the adapter behind an injected supported machine-invocable review client. Do not hard-code a fictional ChatGPT daemon or silently substitute Claude.
- [ ] Make unavailable independent review return a fail-closed stop state.
- [ ] Run GREEN and commit.

### Task 7: Controlled P0 integration and next-task selection

**Files:**
- Create: `crypto-market-monitor-full-source/algo/autonomous-integration-gate.mjs`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-integration-gate.test.mjs`
- Modify: `crypto-market-monitor-full-source/scripts/run-autonomous-build-cycle.mjs`

**Interfaces:**
- Produces: `evaluateIntegrationGate(...)`, `selectNextP0Task(plan, completedGates)`, and a cycle decision that never targets `main`.

- [ ] Write RED tests requiring exact-SHA GREEN + exact-SHA approval before P0 integration, rejecting stale evidence and `main`, enforcing dependency order, and stopping at human/live gates.
- [ ] Verify RED.
- [ ] Implement controlled P0 integration decision and first-incomplete dependency-satisfied task selection.
- [ ] Keep actual GitHub mutation behind an adapter so unit tests cannot merge anything.
- [ ] Run full autonomous test family GREEN and commit.

### Task 8: Persistent daemon, systemd service, and reconciliation loop

**Files:**
- Create: `crypto-market-monitor-full-source/scripts/run-autonomous-orchestrator.mjs`
- Create: `crypto-market-monitor-full-source/deploy/algobot-autonomous-orchestrator.service`
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-orchestrator-cycle.test.mjs`
- Modify: `.github/workflows/algo-v2-autonomous-build.yml`

**Interfaces:**
- Produces: a long-running reconciliation loop with periodic polling, optional event acceleration, structured status output, and graceful shutdown.

- [ ] Write RED cycle tests for restart, duplicate observations, transient GitHub outage, graceful shutdown, lease loss, and no-action idle reconciliation.
- [ ] Verify RED.
- [ ] Implement the daemon composition using Tasks 1-7; no business/safety logic is duplicated in the entrypoint.
- [ ] Convert the existing hourly workflow into verification/heartbeat support rather than the primary scheduler; preserve an auditable artifact.
- [ ] Add systemd hardening/restart policy and environment-file references without committing secrets.
- [ ] Run GREEN and commit.

### Task 9: Failure injection and synthetic end-to-end acceptance

**Files:**
- Create: `crypto-market-monitor-full-source/tests/algo-autonomous-orchestrator-e2e.test.mjs`
- Create: `crypto-market-monitor-full-source/validation/autonomous-orchestrator-acceptance.md`

**Interfaces:**
- Consumes: all orchestrator modules through fake GitHub/Claude/review adapters first; then a dry-run repository path with no production merge.

- [ ] Write a failing synthetic scenario for `TASK_READY -> CLAUDE_WORKING -> CI_RUNNING -> READY_FOR_CHATGPT_REVIEW -> APPROVED_FOR_INTEGRATION -> INTEGRATING -> NEXT_TASK`.
- [ ] Add injected crashes after Claude dispatch, after CI observation, after review recording, and immediately after integration mutation; each restart must reconcile without duplicate side effects.
- [ ] Add negative scenarios for CHANGES_REQUIRED, CI failure, stale approval, human gate, LIVE gate, permission failure, and second-orchestrator contention.
- [ ] Run the synthetic suite until GREEN.
- [ ] Run the complete isolated ALGO regression suite and PostgreSQL P0 suite where applicable.
- [ ] Execute one dry-run GitHub acceptance cycle that cannot merge P0 or place an order; record exact SHAs/runs/evidence in the validation document.
- [ ] Commit acceptance evidence.

### Task 10: Controlled deployment to `algobot-bybit-01`

**Files:**
- Modify only deployment configuration required by the tested service; do not commit credentials.

**Interfaces:**
- Consumes: GREEN Task 9 acceptance evidence.
- Produces: running systemd service with observable health/status and no autonomous production integration until the deployment smoke gate passes.

- [ ] Verify runner host identity, repository checkout, Node 22.13.0, Claude CLI availability/authentication, GitHub write scope, and independent review integration availability.
- [ ] Install the tested systemd unit and environment references.
- [ ] Start in dry-run mode and verify restart recovery plus structured status.
- [ ] Reboot/restart the service and prove it reconstructs state correctly.
- [ ] Enable autonomous integration only to `agent/algobot-p0-persistent-recovery` after the smoke gate is GREEN.
- [ ] Record deployment evidence in GitHub and commit any non-secret documentation changes.

### Task 11: First autonomous real backlog handoff

**Files:**
- No orchestrator code changes unless acceptance exposes a defect; defects require a new RED test first.

**Interfaces:**
- Produces: automatic dispatch of P0 Task 3 Executor Fencing from the approved P0 plan.

- [ ] Confirm Task 2 is integrated and post-integration GREEN on P0.
- [ ] Let the orchestrator select Task 3 without manual task relay.
- [ ] Verify it creates a dedicated Claude branch/PR, obtains exact-SHA CI evidence, requests independent review, and stops/continues according to the recorded verdict.
- [ ] Confirm no write to `main` and no real Bybit order occurred.
- [ ] Publish final automation acceptance evidence and leave the loop enabled for subsequent P0 tasks.
