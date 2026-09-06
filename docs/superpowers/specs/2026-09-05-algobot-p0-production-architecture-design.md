# ALGOBOT P0 Production Architecture Design

## Objective
Harden the current Bybit CANARY execution path into a PostgreSQL-backed, crash-safe, fail-closed execution and recovery engine without authorizing any real order during implementation.

## Non-negotiable safety boundary
- Spot only; BTCUSDT CANARY scope.
- No leverage, margin, Futures, Perpetuals, derivatives or withdrawals.
- Maximum 10 USDT per order and 100 USDT cumulative CANARY authorization.
- `humanApproved` remains mandatory.
- No merge to `main` and no real order transmission as part of this work.
- Supabase/PostgreSQL is authoritative for ALGOBOT execution/recovery state; Bybit is authoritative for exchange facts.

## Current-state findings
`algo/bybit-live-adapter.mjs` currently keeps cumulative committed notional, executed-order idempotency and in-flight state in process memory. A restart therefore loses safety-critical state. The adapter also contains a reconciliation fallback that synthesizes `orderStatus: 'Filled'` when no reconciliation transport is available. Both are P0 blockers.

`algo/bybit-v5-readonly-transport.mjs` already enforces Spot Market order shape and provides order reconciliation by `orderLinkId`/`orderId`, first via realtime orders and then order history. This transport is the exchange-evidence boundary to extend for verified fills/executions and balances.

`algo/live-canary-policy.mjs`, `algo/live-readiness.mjs`, and `algo/risk-engine.mjs` already encode the existing 100 USDT cap, 10 USDT/order readiness rule, Spot/no-leverage constraints, human approval, and risk gating. These remain defense-in-depth checks, but PostgreSQL becomes the concurrency authority for budget and ownership.

## Persistent model
### execution_ledger
One row per logical exchange order, keyed by UUID and unique `order_link_id`. Required states: `CREATED`, `IN_FLIGHT`, `ACKNOWLEDGED`, `PARTIALLY_FILLED`, `FILLED`, `REJECTED`, `CANCELLED`, `FAILED`, `UNKNOWN`. Reconciliation states: `PENDING`, `VERIFIED`, `MISMATCH`. Store requested and exchange-verified quantities/notional, Bybit order id, fees, timestamps and errors.

### position_lifecycle
Persistent position state is separate from order state. States: `OPENING`, `OPEN`, `EXIT_PENDING`, `CLOSING`, `CLOSED`. Quantity, average entry, fees and realized PnL are derived only from verified exchange fills. `EXIT_INTENT` is not an execution status.

### bot_state_meta
A singleton coordination row stores CANARY accounting/recovery metadata and the current executor fencing generation/lease metadata. Reservation and executor ownership operations run transactionally under PostgreSQL locking.

## Atomic CANARY reservation
Reservation is performed in one PostgreSQL transaction while locking the coordination row (`SELECT ... FOR UPDATE` or equivalent). The transaction validates per-order <=10 USDT and aggregate reserved/committed <=100 USDT, creates/binds the execution ledger row, records the reservation, and commits before exchange dispatch. No `SUM`-then-`INSERT` race is allowed.

Reservations have explicit lifecycle so recovery can distinguish: reserved but never transmitted; transmitted/accepted; terminal/released. A crash before Bybit dispatch permits release only after exchange reconciliation proves no order exists. Ambiguity becomes `UNKNOWN` and keeps trading locked.

## Single-writer fencing
Executor acquisition is database-enforced. Each successful ownership acquisition advances a monotonic fencing token. Every execution-authorizing mutation verifies the active token in the same transaction. A stale process carrying an older token cannot reserve budget or transition an order to dispatchable state after a newer executor takes ownership.

## Fail-closed boot gate
Every process begins `TRADING_LOCKED=true`.

Boot sequence: acquire executor ownership -> load DB state -> enumerate unresolved executions/open positions/reservations -> query Bybit -> reconcile ledger/fills/balances/positions -> verify CANARY accounting -> verify fencing/reconciliation health -> set `TRADING_ENABLED` only if every invariant is proven.

Signals received before recovery completion may be evaluated/logged but must never create a dispatchable execution or call Bybit order placement.

Supabase outage, Bybit outage, timeout, malformed payload, unresolved `IN_FLIGHT`, any `UNKNOWN`, accounting mismatch, position mismatch, fencing failure or reconciliation failure leaves the system locked.

## Execution state machine
Normal order path:
`CREATED -> IN_FLIGHT -> ACKNOWLEDGED/PARTIALLY_FILLED -> FILLED`
with terminal alternatives `REJECTED`, `CANCELLED`, `FAILED`; ambiguous exchange evidence is `UNKNOWN`.

Before any irreversible external side effect, durable DB intent/reservation is committed. After dispatch, only exchange evidence may advance fill state. No exchange evidence can ever synthesize success.

## Partial fills
Partial fills are first-class. `filled_qty`, `filled_notional`, average price and fees come from Bybit evidence. BUY positions use actual filled quantity only. SELL requests are capped at verified available position quantity. Partial SELL reduces persistent remaining quantity; only a fully verified close transitions the position to `CLOSED`.

## Persistent position manager
A focused `position-manager.mjs` owns lifecycle transitions and autonomous exit responsibility. Verified BUY fills create/update persistent positions. Cold boot rediscovers non-closed positions from PostgreSQL and reconciles them against Bybit before management resumes.

Exit path: `OPEN -> EXIT_PENDING`, then create a normal SELL ledger record, reserve/validate, `IN_FLIGHT`, dispatch, reconcile verified fills, `CLOSING -> CLOSED`. Restart in `EXIT_PENDING`, `CLOSING` or SELL `IN_FLIGHT` reconciles by `orderLinkId` before any possible resubmission.

## Proposed module boundaries
- `supabase/migrations/*algobot_p0_execution.sql`: schema, constraints, indexes and transactional DB functions.
- `algo/execution-store.mjs`: ledger persistence and state transitions.
- `algo/canary-budget-store.mjs`: transactional reservation/release/commit accounting.
- `algo/executor-fence.mjs`: executor ownership and fencing token validation.
- `algo/recovery-manager.mjs`: startup reconciliation and trading gate.
- `algo/position-manager.mjs`: persistent position lifecycle and exits.
- `algo/bybit-live-adapter.mjs`: orchestration only; no RAM safety authority and no synthetic success.
- `algo/bybit-v5-readonly-transport.mjs`: exchange evidence for orders/fills/balances while preserving Spot-only transport rules.

## TDD and verification architecture
Every implementation slice follows RED -> verify RED -> minimal implementation -> GREEN -> regression -> commit. PostgreSQL integration tests are mandatory for locking, concurrent budget reservations and fencing; mocks are insufficient for these acceptance criteria.

Failure injection must cover all 15 directive boundaries: pre-dispatch crash, reservation crash, network timeout after transmit, accepted-order crash, OPEN crash, EXIT_PENDING crash, SELL post-transmit crash, partial BUY/SELL restart, Supabase/Bybit outage, malformed Bybit response, budget race, fencing race, and signal during recovery.

Every injected failure must end in deterministic recovery or FAIL_CLOSED, with no third outcome.

## Definition-of-done gate
Autonomous CANARY remains unauthorized until persistence, atomic caps, crash-safe reservations, persistent idempotency, fencing, restart/unknown recovery, partial fills, persistent positions, crash-safe SELL, removal of synthetic success, signal freeze, outage locks, real PostgreSQL concurrency tests, isolated ALGO regression suite and GitHub CI are all reproducibly green.
