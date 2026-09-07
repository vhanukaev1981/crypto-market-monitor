# HNK Automation Control Plane — Design

## Objective
Build a reusable, always-on supervision layer for HNK TECHNOLOGIES automations so scheduled workers do not silently stop. The system must detect missed runs, recover automatically where safe, and surface persistent failures without requiring routine manual server interaction.

## Non-negotiable requirements
- Zero new recurring monthly cost. Reuse existing GitHub, Hetzner and connected HNK infrastructure.
- No Make dependency for critical reliability paths.
- No routine SSH/terminal work by the user after bootstrap.
- Never write autonomous integration work to `main`.
- P0 integration target remains `agent/algobot-p0-persistent-recovery`.
- Every implementation task uses a dedicated `agent/claude-*` branch/PR and auditable RED -> GREEN TDD commits.
- Health supervision must never bypass ALGOBOT trading safety. It may restart/check infrastructure but must not manufacture trades, expand LIVE permissions, enable Futures/derivatives/margin/leverage/withdrawals, or change canary limits.
- Secrets must not be committed, logged, or pasted into source-controlled configuration.
- No paid resource, upgrade, SaaS subscription, or additional server may be provisioned without explicit user approval.

## Architecture
The control plane uses five independent responsibilities:

1. **Task Registry** — declarative definitions of supervised jobs: task ID, expected cadence, grace period, health source, recovery policy, and safety class.
2. **Heartbeat Store** — local durable state recording `last_started`, `last_success`, `last_failure`, run ID, duration and compact error metadata. Atomic writes prevent corrupt partial state.
3. **Supervisor / Watchdog** — evaluates registry entries against heartbeat state. A task that exceeds its grace period becomes `STALE`; a safe recovery attempt moves it to `RECOVERING`; repeated failure becomes `DEGRADED`/`FAILED`.
4. **Recovery Adapter** — allow-listed recovery operations only. Initial adapters may restart an approved local systemd service or invoke an approved existing workflow. No arbitrary shell command from registry data.
5. **Independent Health Check** — GitHub Actions periodically validates the supervisor heartbeat/status. This prevents the watchdog from being the sole observer of its own failure.

Data flow:

`Trigger -> Worker -> Heartbeat -> Supervisor -> Recovery -> Status/Alert`

Independent path:

`GitHub Actions -> Supervisor health artifact/status`

## Runtime
The existing Hetzner host is the preferred always-on runtime because it is already paid for. The supervisor runs as a systemd service/timer with restart-on-failure and bounded resource use. Deployment is GitHub-driven so normal updates do not require the user to type commands on the server.

If current GitHub-to-Hetzner authorization cannot support safe unattended deployment, implementation must stop at that boundary and choose a zero-new-cost bootstrap path. It must not turn recurring manual SSH into an accepted operating procedure.

## Task states
- `UNKNOWN`: no trustworthy heartbeat yet.
- `HEALTHY`: latest successful heartbeat is within the configured window.
- `STALE`: expected success is overdue.
- `RECOVERING`: an allow-listed recovery attempt is in progress/cooldown.
- `DEGRADED`: task remains unhealthy after recovery but supervisor is operational.
- `FAILED`: recovery budget exhausted or health evidence is invalid.

State evaluation uses UTC timestamps. Clock-skewed/future timestamps, malformed heartbeat files and missing required fields fail closed.

## Recovery policy
Recovery is bounded and idempotent. Each task specifies a cooldown and maximum attempts in a rolling window. The supervisor must never enter an infinite restart loop. A successful post-recovery heartbeat resets the incident. Failure after the recovery budget is exhausted produces an escalation state instead of continuing destructive retries.

## Initial workers
### Gmail hourly maintenance
The first general worker integration represents the existing hourly Gmail organization job. Its target cadence is 60 minutes with an initial stale threshold of 75 minutes. The control plane records and evaluates execution health separately from notification delivery. Gmail mutation logic remains governed by the existing HNK labeling/deletion safety rules.

A server-side Gmail worker may only be activated once an authorized non-interactive Gmail credential path exists. Until then, the registry may observe the task but must not claim that server-side Gmail processing is operational.

### ALGOBOT monitoring
ALGOBOT monitoring can publish health heartbeats and be supervised for infrastructure continuity. Recovery cannot place orders or modify trading policy. Existing Spot-only and canary controls remain outside and above the control plane's authority.

## Deployment model
Source of truth is GitHub. Deployment artifacts/configuration are versioned, reviewed and tested. The existing Hetzner host pulls/receives approved revisions through an authenticated deployment path. systemd provides local process supervision. Deployment must include a health verification step and rollback/fail-closed behavior when verification fails.

No secret values are stored in the repository. Deployment references environment/credential material already present on the host or GitHub secret storage where available.

## External health check
A GitHub Actions workflow runs on a conservative schedule within available GitHub usage. It checks fresh supervisor evidence rather than merely whether a workflow itself executed. Failure must be visible in GitHub Actions and may open/update a single deduplicated incident surface rather than generating unbounded noise.

The external checker must not depend on Make or a newly purchased monitoring product.

## Cost controls
The implementation has a hard cost gate:
- existing infrastructure first;
- no new recurring charge;
- no automatic provisioning;
- no paid API added merely for monitoring;
- if a required capability cannot be achieved with existing resources, implementation stops and presents the cost and zero-cost alternatives before any purchase.

## Security
- Registry recovery actions are enumerated, not free-form shell.
- Heartbeat/status files contain no credentials or message contents.
- Logs redact secrets and sensitive payloads.
- File permissions follow least privilege.
- Supervisor cannot change ALGOBOT trading limits.
- Gmail credentials, if later used on-host, require least-privilege OAuth scope appropriate to the actual mutation operations.

## Testing and acceptance
Implementation follows RED -> GREEN TDD. Unit tests cover heartbeat validation, stale detection, state transitions, cooldown/retry budgets, malformed/future timestamps and recovery allow-list enforcement.

Integration tests simulate worker success, missed heartbeat, recovery success and recovery exhaustion without touching production Gmail or placing trades.

The system is not `READY` merely because code or CI exists. Production readiness requires end-to-end evidence of:
1. scheduled trigger;
2. worker execution;
3. fresh heartbeat;
4. watchdog evaluation;
5. simulated/controlled stale detection;
6. bounded automatic recovery;
7. post-recovery health verification;
8. independent external health check;
9. multiple consecutive real scheduled cycles without manual intervention.

Any component not actually connected is reported as `NOT CONNECTED`, never inferred as operational.

## Operational UX
The user should consume status, not administer Linux. Normal status must answer: what is healthy, what missed its cadence, what recovered automatically, what remains failed, and whether human authorization is required. Routine server commands are explicitly outside the target operating model.

## Rollout
Phase 1 builds the generic registry, heartbeat evaluator, watchdog and tests.
Phase 2 adds systemd packaging and self-health heartbeat.
Phase 3 adds GitHub external health verification and deployment validation.
Phase 4 connects Gmail only after credential/deployment prerequisites are proven.
Phase 5 onboards additional HNK automations one at a time, preserving each system's own safety boundary.
