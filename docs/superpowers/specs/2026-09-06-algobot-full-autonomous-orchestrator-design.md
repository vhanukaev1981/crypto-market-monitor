# ALGOBOT Full Autonomous Orchestrator Design

## Goal
Build a restart-safe, fail-closed 24/7 orchestration loop on `algobot-bybit-01` that coordinates Claude Code implementation, GitHub Actions verification, ChatGPT independent review, controlled P0 integration, and automatic selection of the next approved P0 task without requiring the user to relay messages.

## Authorities
- GitHub is the canonical control plane and audit log.
- `algobot-bybit-01` is the persistent 24/7 orchestrator host.
- Claude Code is the implementation/TDD worker.
- GitHub Actions is the verification authority.
- ChatGPT is the independent review/safety authority.
- `agent/algobot-p0-persistent-recovery` is the only automatic integration target.
- `main` is outside autonomous write/merge scope.

## Safety invariants
The orchestrator MUST fail closed. It MUST NOT authorize real Bybit orders, unrestricted LIVE trading, futures, derivatives, margin, leverage, withdrawals, transfers, or blind OOS. Existing CANARY limits remain $10/order and $100 cumulative. Human approval remains mandatory for any gate explicitly marked HUMAN_APPROVAL_REQUIRED, LIVE_TRADING_GATE, secret/permission escalation, destructive production action, or change to the safety envelope.

## State machine
Canonical states are `TASK_READY`, `CLAUDE_WORKING`, `CI_RUNNING`, `READY_FOR_CHATGPT_REVIEW`, `CHANGES_REQUIRED`, `APPROVED_FOR_INTEGRATION`, `INTEGRATING`, `NEXT_TASK`, `HUMAN_APPROVAL_REQUIRED`, `SAFETY_BLOCK`, and `UNRECOVERABLE_FAILURE`.

Every transition records repository, task id, branch, PR number, head SHA, CI run id when applicable, review evidence, attempt number, timestamp, and transition reason. A transition is accepted only when its preconditions match the canonical GitHub state. Duplicate events are idempotent.

## Durable state and recovery
The process must not depend on an open Claude or ChatGPT session. GitHub PR/commit/check/review evidence is canonical. The host may keep a local cursor/cache for efficiency, but after restart it reconstructs the actionable state from GitHub before dispatching work. A crash between an external action and local persistence must not duplicate a merge, task dispatch, or review request.

## Claude dispatch
The orchestrator invokes Claude non-interactively from a dedicated repository checkout/worktree with a task packet containing the exact base SHA, task acceptance criteria, required branch, TDD rules, safety constraints, and stop marker. Claude may push only its dedicated task branch and update/open its PR against the P0 integration branch. Claude cannot merge `main` or relax safety gates.

Claude completion markers are machine-readable: `READY_FOR_CI`, `READY_FOR_CHATGPT_REVIEW`, `CHANGES_APPLIED`, or `BLOCKED`. Free-form prose is never sufficient to advance a safety transition.

## CI gate
A task can enter review only when required GitHub Actions checks complete successfully on the exact PR head SHA. A stale GREEN run from an older SHA is invalid. CI failure returns the same task to Claude with bounded retry metadata. Repeated identical failures escalate to `UNRECOVERABLE_FAILURE` rather than looping forever.

## ChatGPT review gate
The orchestrator creates a durable GitHub review request packet containing PR, exact SHA, diff scope, acceptance criteria, CI evidence, and prior review findings. ChatGPT review output is recorded in GitHub as machine-readable `CHANGES_REQUIRED`, `APPROVED_FOR_INTEGRATION`, or `HUMAN_APPROVAL_REQUIRED` evidence tied to the exact SHA. Approval becomes stale after any new commit.

The design does not assume that a normal ChatGPT conversation can be awakened as a daemon. The orchestrator must use an available supported machine-invocable review endpoint/agent integration. If no such endpoint is configured, it MUST stop at `READY_FOR_CHATGPT_REVIEW`; it must never substitute Claude self-review for independent review.

## Integration gate
Only `APPROVED_FOR_INTEGRATION` on the exact head SHA plus current GREEN required checks permits integration into `agent/algobot-p0-persistent-recovery`. Integration must be fast-forward/controlled PR integration with post-integration verification. No autonomous path targets `main`.

## Next-task selection
After post-integration GREEN, the orchestrator reads the approved P0 plan, marks the completed gate, selects the first incomplete dependency-satisfied task, creates a fresh dedicated branch, and dispatches Claude. It must not skip an incomplete prerequisite.

## Event loop
The primary loop runs persistently on `algobot-bybit-01`. GitHub events may accelerate wakeups; periodic reconciliation is mandatory so webhook loss cannot stall the system. Only one active lease for the repository/task state machine is allowed. A second orchestrator instance must observe the lease/fence and remain passive.

## Retry policy
Transient network/API/runner failures use bounded exponential backoff. Code/test failures return to Claude with evidence. Authentication, missing permissions, inconsistent GitHub state, safety-policy mismatch, repeated deterministic failure, or inability to obtain independent review stop fail-closed. No retry may broaden permissions.

## Observability
Each cycle emits structured logs and a compact GitHub-visible status containing state, task, PR, SHA, CI status, review status, retry count, and next action. Secrets are redacted. The user should only need intervention at explicit human gates or unrecoverable blockers.

## Acceptance tests
Before Task 3 is dispatched automatically, tests must prove: valid state transitions; invalid transition rejection; duplicate-event idempotency; exact-SHA CI binding; stale approval rejection; restart reconstruction; crash-after-dispatch recovery; single-active-orchestrator fencing; bounded retry/escalation; CHANGES_REQUIRED returning to Claude; approval allowing only P0 integration; `main` rejection; human/live-trading gates stop; and one end-to-end synthetic cycle `TASK_READY -> Claude -> CI GREEN -> independent review approval -> P0 integration -> NEXT_TASK` without a user relay.

## Rollout
Phase 1 is dry-run/synthetic with no production merge. Phase 2 permits autonomous integration only into the P0 branch after all acceptance tests are GREEN. Task 3 is the first real backlog task dispatched by the new loop. LIVE trading remains separately gated and is not enabled by this project.
