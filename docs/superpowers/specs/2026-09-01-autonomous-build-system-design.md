# ALGO TRADING Autonomous Build System Design

## Goal
Build a development-only autonomous orchestration layer that continuously advances ALGO TRADING without requiring repeated chat prompts, while preserving strict engineering evidence and preventing autonomous promotion into live trading or production release.

## Scope
The system automates software construction: repository inspection, task selection, isolated implementation, tests, CI, debugging, commits, Draft PR maintenance, research/backtest infrastructure, paper infrastructure, documentation, and evidence collection.

It does not autonomously enable live-money trading, leverage, production release, merge to `main`, change secrets, or weaken risk limits.

## Architecture

### 1. Autonomous Build Orchestrator
A scheduled worker wakes on a fixed cadence and also reacts to repository state. Each cycle reads the authoritative project state, selects exactly one safe next development task, executes it through the engineering gates, records evidence, and leaves the repository in a resumable state.

### 2. GitHub as source of truth
GitHub branches, Draft PRs, workflow runs, artifacts, and a machine-readable build-state file are the durable coordination layer. Chat history is not required for continuation.

### 3. Single-writer concurrency
Only one autonomous build cycle may mutate the active development branch at a time. GitHub Actions uses a concurrency group with cancellation disabled for qualification work. The orchestrator refuses a new mutation cycle while another build lease is active.

### 4. Task queue
Tasks have states `READY`, `IN_PROGRESS`, `BLOCKED`, `DONE`. Selection is deterministic: safety defects first, then failing regression/CI, data-quality and reconciliation, paper-readiness infrastructure, canonical research infrastructure, observability, then non-critical refactoring.

A blocked task records a blocker and retry count; the worker moves to another independent READY task instead of looping indefinitely.

### 5. Engineering loop
For behavior changes the worker follows TDD:
1. inspect current behavior;
2. add a focused failing regression test;
3. verify RED;
4. implement the minimum correction;
5. verify GREEN;
6. run relevant regression;
7. commit;
8. update Draft PR/evidence;
9. select the next task.

Configuration-only changes must still have direct verification evidence from the affected system.

### 6. Evidence ledger
Every cycle records: task ID, starting SHA, resulting SHA, tests executed, RED/GREEN evidence where applicable, workflow run IDs, artifacts, blockers, and next eligible task. No PASS/READY claim is valid without fresh evidence.

### 7. Permission gates
Autonomous development is allowed to read repository state; create/update isolated development branches; write tests and implementation; run CI/backtests/research inside the permitted research window; debug; commit; maintain Draft PRs; and update documentation/evidence.

Hard stop actions requiring explicit human approval are: live-money execution, leverage enablement, secret/API-key changes, weakening safety limits, merge to `main`, production deployment/release, destructive repository operations, and using blind OOS data for tuning.

### 8. OOS and trading separation
The build orchestrator cannot treat good research results as permission to trade. Canonical Spot research remains restricted to the approved research window. Blind OOS access remains separately gated and cannot be repeatedly opened for tuning.

## Failure handling
- Test failure: diagnose root cause, add/retain regression evidence, fix, rerun.
- CI infrastructure failure: distinguish infrastructure from code failure and repair only reversible development configuration.
- Repeated failure: after a bounded retry budget, mark task BLOCKED with evidence and continue another independent task.
- Corrupt/ambiguous state: fail closed; do not infer completion.
- Missing evidence: status remains unverified.

## Scheduling
The intended default cadence is hourly. Event-driven GitHub Actions continue immediately on pushes. The scheduled orchestrator is responsible for resuming development when no human chat session is active.

## Success criteria
- Development can resume from durable repository state without a chat prompt.
- A completed task always has test/CI evidence and a commit SHA.
- Failed work is resumable and does not disappear into conversational context.
- Independent work continues when one task is blocked.
- No autonomous path can merge `main`, deploy production, enable live trading/leverage, modify secrets, weaken risk controls, or tune on blind OOS.
- Qualification remains fail-closed.
