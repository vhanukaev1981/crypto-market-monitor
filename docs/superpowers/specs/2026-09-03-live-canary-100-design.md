# $100 Live Canary Design

## Goal
Add a strictly bounded live Spot-trading canary that may use at most USD 100 of explicitly allocated capital, while preserving the existing Paper pipeline and fail-closed safety model.

## Scope
- Spot only.
- Maximum live-canary allocated capital: USD 100.
- No leverage, margin, futures, derivatives, withdrawals, transfers, or blind-OOS tuning.
- Existing Paper execution remains the default execution mode.
- Live execution is a separate adapter behind an explicit LIVE_CANARY gate.
- PR #8 remains Draft; no merge to main is part of this work.

## Safety invariants
1. Live is disabled by default.
2. Missing, stale, malformed, or ambiguous qualification/readiness evidence blocks live execution.
3. The adapter rejects any order that would make aggregate live-canary committed capital exceed USD 100.
4. The adapter accepts Spot instruments only and rejects leverage/margin/futures semantics.
5. The adapter cannot withdraw or transfer funds.
6. Existing risk-engine decisions, exposure controls, drawdown halt, execution-cost checks, idempotency and reconciliation remain mandatory upstream gates.
7. A failed or uncertain exchange response is not treated as a successful fill; reconciliation is required before another potentially conflicting order.
8. Secrets are never committed to the repository. Exchange credentials must be supplied only through an approved secret store with least-privilege trade-only API permissions.
9. Dry-run is mandatory before the live-enable gate can be considered ready.
10. Automation must fail closed if exact-head qualification is not PASS.

## Architecture
Paper and Live Canary share the validated signal/risk/readiness pipeline, then diverge at execution. A new live-canary policy module validates mode, budget, instrument class, readiness and safety invariants. A live adapter may submit an order only after that policy returns an explicit ALLOW decision. The autonomous development orchestrator may build/test this subsystem, but it may not create credentials or enable the final live gate autonomously.

## Verification
Development follows TDD. Tests must prove default-off behavior, USD 100 aggregate cap, Spot-only enforcement, rejection of leverage/margin/futures, stale/missing qualification rejection, dry-run behavior, ambiguous-response reconciliation lock, and preservation of existing Paper behavior. Exact-head GitHub CI must pass before any credential configuration or live enablement.

## Activation gate
Actual exchange connectivity requires a separate security-sensitive configuration step after code/CI readiness: create a least-privilege exchange API key with trading only, withdrawals disabled, store it in an approved secret store, run dry-run/connectivity verification, then explicitly enable LIVE_CANARY. This activation must never be inferred from the existence of credentials.