# ALGO V2 Paper Readiness Design

**Date:** 2026-08-31

## Goal
Advance ALGO TRADING from research/validation into a stable autonomous paper-trading system while keeping live-money execution locked until an explicit production approval.

## Baseline
- Development baseline: `agent/algo-v2-core-v1`.
- Canonical target market: Bybit Spot.
- Canonical Spot research source: Bybit public Spot trade archive aggregated fail-closed to 1H OHLCV.
- Research/validation window: 2022-11 through 2024-12.
- 2025-01 onward remains blind OOS until the candidate is frozen.
- Existing V1.2 strategy thresholds remain frozen during validation.

## Architecture
Market data flows through strict data-quality validation before reaching the frozen strategy evaluator. Signals must pass the deterministic risk engine before reaching the paper executor. Portfolio state, P&L, exposure, execution costs, reason codes, and health state are recorded so every autonomous action is attributable and recoverable.

## Safety invariants
1. Live trading remains disabled.
2. No leverage.
3. No merge to `main` until CI, canonical Spot validation, blind OOS integrity, risk/execution regression, and paper-readiness gates pass.
4. Maximum drawdown halt remains 5%.
5. Entry allocation cap remains 25% and emergency continuous exposure cap remains 30%.
6. Invalid/stale/incomplete market data fails closed.
7. A rejected or halted risk decision cannot reach execution.
8. Paper orders are idempotent and state is recoverable after restart.
9. Research code cannot read the blind OOS window.

## Delivery stages
### 1. CI and repository hardening
Diagnose `action_required` runs separately from code failures. Preserve workflow least privilege and add deterministic workflow/regression checks where repository behavior can be tested locally.

### 2. Data integrity
Verify Spot archive schema, aggregation, contiguous hourly coverage, duplicate/gap handling, stale-data rejection, and provenance metadata. Any integrity failure blocks downstream strategy evaluation.

### 3. Candidate freeze and blind OOS
Run research only through 2024-12, freeze the candidate and its configuration/hash, then permit the blind OOS runner to read 2025+ exactly once under the existing OOS controls. Do not tune against OOS output.

### 4. Risk and execution integration
Prove that APPROVED/REDUCED_SIZE decisions are the only decisions eligible for paper execution, HALT_SYSTEM is sticky until an explicit reset policy is satisfied, exposure caps cannot be bypassed, and duplicate order identifiers cannot double-fill.

### 5. Autonomous paper trading
Create/verify a fail-closed orchestration loop: ingest -> quality -> signal -> risk -> paper execution -> portfolio/P&L -> journal/health. Restart must restore state without replaying fills.

### 6. Observability and recovery
Emit structured health status, data freshness, last successful cycle, risk state, exposure, P&L/drawdown, order/fill counters, and explicit failure reason codes. Recoverable upstream failures retry with bounded backoff; unsafe state halts execution.

## Acceptance gates
Paper readiness requires all isolated ALGO tests green, canonical Spot research artifact generated from the locked research window, OOS lock regression green, candidate freeze verified, risk/execution integration green, deterministic restart/idempotency tests green, and an autonomous paper loop that fails closed under injected data/API/state faults.

Live readiness is a separate milestone and requires explicit user approval after paper-trading evidence is reviewed.