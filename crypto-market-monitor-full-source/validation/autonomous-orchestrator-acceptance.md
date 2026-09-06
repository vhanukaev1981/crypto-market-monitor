# ALGOBOT Full Autonomous Orchestrator — Acceptance Evidence

Spec: `docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md`
Plan: `docs/superpowers/plans/2026-09-06-algobot-full-autonomous-orchestrator.md`
Implementation branch: `agent/autonomous-orchestrator-v1`
Verification authority: GitHub Actions workflow **ALGOBOT Autonomous Orchestrator TDD**
(`.github/workflows/algobot-autonomous-orchestrator-tdd.yml`).

All work is strict RED → GREEN TDD. Every task pushed a RED commit (dedicated
test, no implementation) that produced a **failing** CI run, then a GREEN commit
that produced a **passing** CI run on the exact head SHA.

## Task CI ledger (RED → GREEN, exact SHA)

| Task | RED commit / run | GREEN commit / run |
|---|---|---|
| CI workflow bootstrap | — | `83f8ca2` |
| 1 — deterministic state machine | `2942203` · run [34055102322](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34055102322) ✗ | `fdba09a` · run [34055797806](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34055797806) ✓ |
| 2 — canonical GitHub reconciliation | `018d0fd` · run [34055965588](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34055965588) ✗ | `6cc1b34` · run [34056040760](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056040760) ✓ |
| 3 — single-active lease / fencing | `f044969` · run [34056146304](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056146304) ✗ | `7ebac90` · run [34056223434](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056223434) ✓ |
| 4 — Claude non-interactive dispatch | `0a34e74` · run [34056308379](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056308379) ✗ | `e237c5a` · run [34056372723](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056372723) ✓ |
| 5 — CI exact-SHA gate + bounded retry | `61a7309` · run [34056420005](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056420005) ✗ | `8f123e2` · run [34056493200](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056493200) ✓ |
| 6 — independent ChatGPT review adapter | `3d099fe` · run [34056539777](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056539777) ✗ | `8530492` · run [34056624769](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056624769) ✓ |
| 7 — controlled P0 integration + next-task | `46ce686` · run [34056728813](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056728813) ✗ | `914a4aa` · run [34056814373](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34056814373) ✓ |
| 8 — persistent reconciliation loop + daemon | `35aefa9` · run [34057028395](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34057028395) ✗ | `6364a15` · run [34057159662](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34057159662) ✓ |
| 9 — failure injection + synthetic E2E | this commit (RED: 3 acceptance-surfaced gaps) | this commit (GREEN) |

## Modules

| File | Purpose |
|---|---|
| `algo/autonomous-orchestrator-state.mjs` | Pure state machine: 11 canonical states, 15 events, exact-SHA binding, idempotent replay, hard `main` rejection. |
| `algo/autonomous-github-reconciler.mjs` | Rebuilds the actionable state from GitHub only; local cache never authoritative; crash-after-integration recovery via `isAncestor`. |
| `algo/autonomous-orchestrator-lease.mjs` | Durable compare-and-set lease with a monotonic fence token; stale instances fenced out of assert / renew / release / guarded mutation. |
| `algo/autonomous-claude-dispatch.mjs` | Exact-SHA task packet; injected process runner; accepts only machine-readable completion markers; never targets `main`. |
| `algo/autonomous-ci-gate.mjs` | Exact-SHA CI classification; deterministic vs transient failure; bounded retry / escalation; no permission broadening. |
| `algo/autonomous-review-gate.mjs` | Independent review behind an injected client; unconfigured → fail-closed stop; Claude-like / self identities rejected; every verdict exact-SHA bound. |
| `algo/autonomous-integration-gate.mjs` | INTEGRATE only on exact-SHA GREEN + exact-SHA APPROVED into the P0 branch; dependency-ordered next-task selection; `LIVE_TRADING_GATE` / human-gated tasks stop for a human. |
| `algo/autonomous-orchestrator-loop.mjs` | Composition. Holds no authoritative local state; every mutation fenced; graceful shutdown; terminal-state stop. |
| `scripts/run-autonomous-orchestrator.mjs` | Thin systemd entrypoint. Default `--dry-run`; `--live` fail-closed until Task 10. |
| `deploy/algobot-autonomous-orchestrator.service` | Hardened systemd unit; `Restart=always` + restart-storm guard; secrets only via `EnvironmentFile`. |

## Acceptance criteria → evidence (spec §54)

| Requirement | Where proven |
|---|---|
| Valid state transitions | `algo-autonomous-orchestrator-state.test.mjs` — full `TASK_READY → NEXT_TASK` path |
| Invalid transition rejection | same — `ORCHESTRATOR_INVALID_TRANSITION` / `ORCHESTRATOR_INVALID_EVENT` |
| Duplicate-event idempotency | same — replayed `event.id` returns the identical snapshot |
| Exact-SHA CI binding | `...-state`, `...-ci-gate`, `...-github-reconciler`, `...-e2e` (stale GREEN never opens the gate) |
| Stale approval rejection | `...-state`, `...-review-gate`, `...-integration-gate`, `...-e2e` (stale approval → no integration) |
| Restart reconstruction | `...-github-reconciler`, `...-orchestrator-cycle`, `...-e2e` (fresh loop resumes from `reconcile()`) |
| Crash-after-dispatch recovery | `...-e2e` — crash after dispatch / after CI / after the integration mutation; no duplicate side effect |
| Single-active-orchestrator fencing | `...-orchestrator-lease`, `...-orchestrator-cycle`, `...-e2e` — stale fence token mutates nothing |
| Bounded retry / escalation | `...-ci-gate` — deterministic fail past budget → `UNRECOVERABLE_FAILURE` |
| CHANGES_REQUIRED → Claude | `...-integration-gate`, `...-e2e` |
| Approval allows only P0 integration | `...-integration-gate`, `...-e2e` — target is always `agent/algobot-p0-persistent-recovery` |
| `main` rejection | every module — construction, event, snapshot, decision target |
| Human / LIVE-trading gates stop | `...-review-gate` (HUMAN), `...-integration-gate` + `...-e2e` (`STOP_LIVE_GATE`) |
| One end-to-end synthetic cycle, no user relay | `...-e2e` — `E2E happy path` walks `TASK_READY → Claude → CI GREEN → independent approval → P0 integration → NEXT_TASK` with exactly one integration, never `main` |

## Regression

- Isolated ALGO regression suite (55 files, DB-backed P0 excluded, `--test-concurrency=1`): **369 / 369 pass**, exit 0 (local).
- Autonomous family (`tests/algo-autonomous-*.test.mjs`): **168 / 168 pass**.
- PostgreSQL P0 suite: unaffected by this work (no orchestrator module imports the DB layer); it is verified on its own branch/workflow.

## Dry-run acceptance cycle (cannot merge P0, cannot place an order)

`node scripts/run-autonomous-orchestrator.mjs --dry-run --once` →

```
{"level":"status","state":"CLAUDE_WORKING","action":"AWAIT_CLAUDE","taskId":null,"prNumber":null,"headSha":null,"ciOutcome":null,"reviewStatus":null}
{"level":"result","status":"OK","action":"AWAIT_CLAUDE","state":"CLAUDE_WORKING"}
```

The dry-run adapters are side-effect-free: `integratePr` is logged and suppressed,
the review client is `configured: false` (fail-closed), and `dispatchClaude`
returns `BLOCKED / DRY_RUN`. No Bybit, no LIVE trading, no write to `main`.

## Rollout status

- **Phase 1 (this branch): COMPLETE for Tasks 1–9.** Synthetic + dry-run acceptance GREEN.
- **Task 10 — controlled deployment to `algobot-bybit-01`:** requires host access
  (runner identity, Node 22.13.0, Claude CLI auth, GitHub write scope) and a
  configured machine-invocable independent-review endpoint. **Blocked pending the
  human owner** — see the PR description.
- **Task 11 — first autonomous handoff of P0 Task 3 (Executor Fencing):** runs
  only after Task 10's smoke gate is GREEN.

**No autonomous change has been merged to `agent/algobot-p0-persistent-recovery`
or `main`. No real Bybit order has been placed.**

---

## PR #19 independent review — round 2 (CHANGES_REQUIRED → addressed)

ChatGPT independent review of `fd28366` returned **CHANGES_REQUIRED** (recorded on
PR #19, tied to the exact SHA). All four critical blockers, the seven Codex
inline threads, and the additional important fixes were addressed via strict
RED → GREEN TDD:

| Fix commit group | RED run | GREEN run | Scope |
|---|---|---|---|
| A `91b22b7` → `d46ef67` | [34058309499](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34058309499) ✗ | [34058356201](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34058356201) ✓ | full event-id dedup (not just `lastEventId`); reject completion markers on a nonzero Claude exit; CI-gate latest-run by timestamp/runId not array order; systemd `StartLimit*` moved to `[Unit]` |
| B `265d7b1` → `fa18192` | [34058406256](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34058406256) ✗ | [34058520922](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34058520922) ✓ | reconciler: durable integration evidence (merged PR **or** ledger) + exact-SHA GREEN on the **integration branch head** before `NEXT_TASK`; a fresh branch == base is not "integrated" |
| C `17d2ccc` → `ec8abf8` | [34058735337](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34058735337) ✗ | [34059001696](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34059001696) ✓ | loop threads the **real state machine + a durable `{snapshot,runtime}` store**: attempt counter & event dedup survive restart; lease **renewed every tick**, lost lease STOPS the daemon; permission-denied mutation → `STOP_PERMISSION`; malformed / auth review → `STOP_REVIEW_MALFORMED` / `STOP_REVIEW_ERROR`; plan-load failure → `STOP_PLAN_UNAVAILABLE`; review request id persisted, submitted once per head; script acquires the lease before building the loop |
| D `871327b` → `858ddb6` | [34059075501](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34059075501) ✗ | (this PR head) ✓ | concrete live adapters: `createGithubRestAdapter`, `createGithubFileLeaseStore`, `createGithubStateStore`, `createClaudeCliRunner`, `parseP0Plan` (all injected-transport, unit-tested); `--live` wires them, integration stays suppressed unless `ALGOBOT_ENABLE_P0_INTEGRATION=1` |
| E (this commit) | — | — | heartbeat workflow: `|| true` removed, `set -euo pipefail`, fails on any fatal/safety signal line; acceptance doc updated |

### Coverage after round 2

- The synthetic E2E now drives the loop through the **real** `createOrchestratorStateMachine`
  and threads a durable state store; a controlled merge writes the ledger and a
  merged PR, and `NEXT_TASK` requires GREEN CI on the integration branch head.
- New failure-injection scenarios: durable bounded-retry across restarts →
  `STOP_UNRECOVERABLE`; same failed run not double-counted; lease renewed each
  tick; lost lease → daemon `STOPPED`; permission-denied mutation → `STOP_PERMISSION`;
  malformed / unauthorised review → fail-closed stop; plan-load failure ≠ backlog
  exhausted.
- Isolated ALGO regression + autonomous family remain GREEN (family 201/201 after
  Commit D).

**Still true:** no autonomous change merged to `agent/algobot-p0-persistent-recovery`
or `main`; no real Bybit order; Tasks 10–11 remain blocked on the host owner
(shell access to `algobot-bybit-01`, provisioning the independent-review endpoint,
and enabling `ALGOBOT_ENABLE_P0_INTEGRATION=1` after the smoke gate).

---

## PR #19 independent re-review 2 (CHANGES_REQUIRED on 140d881) — addressed

Fix commit groups F–H, each RED test-only commit → failing CI, each fix commit → passing CI:

| Group | RED → GREEN | Blockers |
|---|---|---|
| F `81d60cd` → `a573f71` | [34060067336](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34060067336) ✗ / [34060274695](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34060274695) ✓ | **R1** every control-plane read/write pinned to a non-protected `controlBranch` (`?ref=` + `body.branch`); **R2 backend** `leaseCheck()` at commit time; **R6** trusted-author review markers + `reviewerId` + malformed surfaced; **I-a** 401/403 → `ORCHESTRATOR_ADAPTER_AUTH` (not transient); **I-b** `getCiStatus` per-check in one call, empty required-checks refused; **I-c** plan DONE from ~~strike~~/**DONE**/(status); **I-d** ledger write failure propagates |
| G `fa79772` → `344e8ee` | [34060386379](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34060386379) ✗ / [34060576650](https://github.com/vhanukaev1981/crypto-market-monitor/actions/runs/34060576650) ✓ | **R5** load IO error → `STOP_STATE_UNAVAILABLE`, invalid snapshot → `STOP_STATE_INVALID`, save failure → `STOP_STATE_PERSIST_FAILED` (decision not executed); **R2 loop** fence re-asserted immediately before each mutation; **R3** durable control-branch task cursor + fresh `agent/claude-*` branch + real P0 head base SHA (never zeros); **R4** review-request intent persisted before submit, id re-persisted after, submitted once per head; canonical `recordApproval` evidence; `integratePr` carries `taskId` |
| H (this) | — | **R2** Claude dispatch is a detached kick-off (`{ detached: true }`) — a ~1h run is never held open inside a fenced mutation; the dispatcher accepts `DISPATCHED` |

### Prior-review disposition (round 1 items) — all confirmed fixed
fresh-branch ancestry, acquired-token propagation, lease renew/reacquire, full
event-id dedup, nonzero Claude-exit rejection, systemd `StartLimit` placement,
heartbeat failure propagation, pure CI latest-run ordering.

### Corrections to earlier overstatements
- Live adapters are now genuinely control-branch-isolated and fenced at commit
  time; the earlier "live guarantees" claims that predated F/G are superseded by
  this section.
- `--live` additionally refuses to start without a non-protected
  `ALGOBOT_CONTROL_BRANCH` and a non-empty `ALGOBOT_REQUIRED_CHECKS`.

Regression after H: autonomous family **221/221**; full isolated ALGO regression
GREEN; `--dry-run --once` exit 0. No merge to `agent/algobot-p0-persistent-recovery`
or `main`; no real Bybit order; Tasks 10–11 remain owner-blocked.
