# ALGO TRADING Autonomous Build System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable development-only autonomous loop that resumes ALGO TRADING construction without repeated chat prompts and produces evidence-backed commits and Draft PR updates.

**Architecture:** GitHub is the durable source of truth. A machine-readable build-state/task queue plus an hourly orchestrator workflow selects one safe task per lease, delegates execution through existing engineering workflows, records evidence, and resumes later. All promotion/live/secret/destructive actions remain outside the autonomous permission boundary.

**Tech Stack:** GitHub Actions, Node.js 22.13.0, ESM `.mjs`, `node:test`, GitHub repository state and artifacts.

**Spec:** `docs/superpowers/specs/2026-09-01-autonomous-build-system-design.md`

## Global Constraints

- Development automation only; no live-money execution.
- No leverage enablement.
- No secret/API-key changes.
- No weakening of risk limits.
- No merge to `main`.
- No production deployment/release.
- No destructive repository operations.
- No blind OOS tuning.
- Node.js qualification version is `22.13.0`.
- Every PASS/READY claim requires fresh evidence.
- Exactly one writer may mutate the active autonomous-development state at a time.

---

## File Structure

- Create `crypto-market-monitor-full-source/algo/autonomous-build-state.mjs` — validate/select/transition durable task state fail-closed.
- Create `crypto-market-monitor-full-source/tests/algo-autonomous-build-state.test.mjs` — state-machine and permission tests.
- Create `crypto-market-monitor-full-source/validation/autonomous-build-state.json` — durable queue/checkpoint.
- Create `crypto-market-monitor-full-source/scripts/run-autonomous-build-cycle.mjs` — deterministic cycle planner that emits the next safe action/evidence request; it never performs red-zone actions.
- Create `crypto-market-monitor-full-source/tests/algo-autonomous-build-cycle.test.mjs` — planner behavior tests.
- Create `.github/workflows/algo-v2-autonomous-build.yml` — hourly/manual orchestrator with concurrency lock and least permissions.
- Modify `.github/workflows/algo-v2-bybit-spot-research.yml` — expose qualification evidence consistently and preserve concurrency.
- Create `crypto-market-monitor-full-source/validation/autonomous-build-evidence.schema.json` — evidence ledger contract.

### Task 1: Fail-Closed Build State Machine

**Interfaces:**
- Produces `validateBuildState(state)`, `selectNextTask(state)`, `transitionTask(state, taskId, nextStatus, evidence)`.
- Task statuses: `READY | IN_PROGRESS | BLOCKED | DONE`.
- Priority order: `SAFETY`, `REGRESSION`, `DATA_QUALITY`, `RECONCILIATION`, `PAPER_READINESS`, `RESEARCH_INFRA`, `OBSERVABILITY`, `REFACTOR`.

- [ ] Write tests proving malformed state, duplicate task IDs, unknown statuses/priorities, invalid retry counts, and forbidden action classes are rejected with `AUTONOMOUS_BUILD_INVALID_STATE`.
- [ ] Run `node --test tests/algo-autonomous-build-state.test.mjs`; verify RED because module does not exist.
- [ ] Implement validation and deterministic selection. `selectNextTask` must choose the lowest priority-rank READY task and use task ID as deterministic tie-breaker.
- [ ] Implement transition rules: `READY -> IN_PROGRESS`; `IN_PROGRESS -> DONE|BLOCKED|READY`; `BLOCKED -> READY` only when retry budget remains; no transition out of DONE.
- [ ] Run the focused test and verify GREEN.
- [ ] Commit `feat: add autonomous build state machine`.

### Task 2: Durable Queue and Permission Boundary

**Interfaces:**
- Build-state JSON version `1` with fields `version`, `lease`, `tasks`, `lastCycle`.
- Each task: `id`, `priority`, `status`, `actionClass`, `retryCount`, `maxRetries`, `dependsOn`, `blocker`, `evidence`.
- Allowed action classes: `TEST`, `IMPLEMENT`, `DEBUG`, `CI`, `BACKTEST_INFRA`, `PAPER_INFRA`, `DOCS`, `OBSERVABILITY`.
- Forbidden classes: `LIVE_TRADING`, `LEVERAGE`, `SECRETS`, `WEAKEN_RISK`, `MERGE_MAIN`, `PRODUCTION_RELEASE`, `DESTRUCTIVE`, `BLIND_OOS_TUNING`.

- [ ] Extend state-machine tests with one example for every forbidden class and dependency blocking.
- [ ] Verify RED.
- [ ] Create `validation/autonomous-build-state.json` seeded with current hardening follow-ups: CI qualification, restart reconciliation, risk enum validation, data-quality hardening, readiness integration, observability.
- [ ] Implement dependency-aware selection and forbidden-action rejection.
- [ ] Verify focused GREEN and run `node --test tests/algo-autonomous-build-state.test.mjs tests/algo-paper-executor.test.mjs tests/algo-risk-engine.test.mjs tests/algo-execution-gateway.test.mjs tests/algo-paper-readiness.test.mjs`.
- [ ] Commit `feat: persist autonomous build queue and permissions`.

### Task 3: Deterministic Build Cycle Planner

**Interfaces:**
- `planAutonomousBuildCycle({ state, repository, qualification })` returns `{ status, task, requestedAction, reasonCode, evidenceRequirements }`.
- Status values: `WORK`, `WAIT`, `BLOCKED`, `COMPLETE`.
- The planner never writes GitHub state or executes shell commands; orchestration remains auditable.

- [ ] Write tests for: selecting safety work first; WAIT when a valid lease is active; BLOCKED when all unfinished tasks are blocked; COMPLETE when all tasks are DONE; CI-failure task precedence; forbidden task rejection.
- [ ] Run focused test and verify RED.
- [ ] Implement `scripts/run-autonomous-build-cycle.mjs` plus pure planner module behavior.
- [ ] Verify GREEN.
- [ ] Add CLI mode that reads `validation/autonomous-build-state.json` and emits one JSON plan to stdout; malformed input exits non-zero without modifying files.
- [ ] Run CLI against committed state and verify deterministic output twice.
- [ ] Commit `feat: add autonomous build cycle planner`.

### Task 4: Evidence Ledger Contract

**Interfaces:**
- Evidence entry fields: `taskId`, `startedAt`, `startSha`, `resultSha`, `tests`, `workflowRuns`, `artifacts`, `redEvidence`, `greenEvidence`, `blockers`, `result`.
- `result`: `PASS | FAIL | BLOCKED | UNVERIFIED`.

- [ ] Write tests rejecting PASS without at least one fresh test/workflow evidence item and rejecting mismatched task IDs/SHAs.
- [ ] Verify RED.
- [ ] Create `validation/autonomous-build-evidence.schema.json` and validation function in the build-state module.
- [ ] Verify GREEN.
- [ ] Commit `feat: require evidence for autonomous build completion`.

### Task 5: Hourly GitHub Orchestrator

**Files:** `.github/workflows/algo-v2-autonomous-build.yml`.

**Interfaces:**
- Triggers: `schedule` hourly and `workflow_dispatch`.
- Permissions: `contents: read` by default; mutation jobs must use the minimum separately justified permission.
- Concurrency group: `algo-v2-autonomous-build`; `cancel-in-progress: false`.

- [ ] Create workflow with checkout and Node `22.13.0`.
- [ ] Run the state/planner tests before any cycle decision.
- [ ] Execute planner CLI and upload its JSON decision as an artifact.
- [ ] If planner returns WAIT/BLOCKED/COMPLETE, exit successfully without repository mutation.
- [ ] For WORK, dispatch only an allow-listed development workflow/action; do not include credentials or commands for any forbidden action class.
- [ ] Add explicit guard step that fails if task actionClass is not in the allow-list.
- [ ] Push and verify GitHub recognizes the workflow and a manual/scheduled run reaches the planner step.
- [ ] Commit `ci: add hourly autonomous build orchestrator`.

### Task 6: Qualification and Retry Integration

- [ ] Add tests for bounded retries: a failed task increments `retryCount`; at `maxRetries` it becomes BLOCKED; another independent READY task is then selected.
- [ ] Verify RED then implement minimal retry transition behavior.
- [ ] Add `concurrency` to canonical Spot qualification so two canonical research runs cannot overlap.
- [ ] Ensure qualification artifact includes run ID/result path consumed by evidence ledger.
- [ ] Run unit regression and trigger canonical workflow on the hardening branch.
- [ ] Record run IDs and conclusions in the Draft PR/evidence state only after they actually complete.
- [ ] Commit `feat: resume autonomous work after bounded failures`.

### Task 7: End-to-End Development-Only Safety Test

- [ ] Create a fixture queue containing one allowed failing regression task and all forbidden action classes.
- [ ] Verify planner selects only the allowed development task.
- [ ] Simulate PASS evidence and transition it DONE.
- [ ] Verify the planner refuses every forbidden class even when it is the only remaining task.
- [ ] Run all isolated ALGO tests under Node `22.13.0`.
- [ ] Trigger the autonomous workflow and verify concurrency/evidence artifact behavior.
- [ ] Update Draft PR #8 with exact test counts, workflow IDs, and remaining blockers.
- [ ] Do not mark the PR ready or merge it as part of this plan.
- [ ] Commit `test: verify autonomous build safety boundary`.

## Completion Gate

The autonomous build subsystem is considered implemented only when:
1. all new state/planner/evidence tests pass under Node `22.13.0`;
2. the hourly/manual workflow executes successfully with a concurrency lock;
3. a WORK cycle produces auditable evidence and a later cycle can resume from durable state;
4. a BLOCKED task does not prevent an independent READY task from being selected;
5. every forbidden action class is rejected in tests and absent from workflow mutation paths;
6. PR remains Draft and `main`/production/live trading remain untouched.
