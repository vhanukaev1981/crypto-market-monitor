# ChatGPT Bybit Control — Read-only Integration Contract

## Mission

Expose the existing Bybit account snapshot capability as a safe read-only control-plane surface for ChatGPT without creating another trading system or weakening the existing ALGOBOT live-canary policy.

## Non-negotiable safety boundary

- Read-only Bybit API credentials only.
- No order create, amend, cancel, transfer, withdrawal, leverage, trading-stop, or position mutation endpoints.
- This integration MUST NOT enable futures/perpetual execution in ALGOBOT.
- Existing live-canary policy remains unchanged.
- Secrets never enter ChatGPT, client code, repository files, logs, or response payloads.
- Fail closed if environment/account identity cannot be verified.

## Target account

The data source is the Bybit AI trading sub-account used by the current controlled experiment. Account identity must be verified at runtime before a snapshot is accepted. Do not infer identity from labels.

## Canonical snapshot

A successful snapshot should expose only normalized read data:

```json
{
  "ok": true,
  "checked_at": "ISO-8601",
  "source": "bybit_mainnet_readonly",
  "account": {
    "total_equity": 0,
    "total_wallet_balance": 0,
    "total_available_balance": 0,
    "total_margin_balance": 0,
    "total_initial_margin": 0,
    "total_maintenance_margin": 0,
    "total_perp_upl": 0
  },
  "assets": [],
  "linear_positions": [
    {
      "symbol": "XRPUSDT",
      "side": "Sell",
      "size": 0,
      "avg_price": 0,
      "mark_price": 0,
      "position_value": 0,
      "unrealised_pnl": 0,
      "leverage": 0,
      "liquidation_price": null,
      "stop_loss": null,
      "take_profit": null
    }
  ],
  "spot_open_orders": 0,
  "linear_open_orders": 0,
  "sends_exchange_orders": false
}
```

## Bybit read endpoints

Allowlist only the minimum GET endpoints required for the control view:

- `GET /v5/account/wallet-balance`
- `GET /v5/position/list`
- `GET /v5/order/realtime`
- `GET /v5/market/tickers`
- optionally read-only execution/history endpoints when needed for journal reconciliation.

Use an explicit allowlist. Do not use a broad rule such as “any /v5 endpoint except known writes”.

## Reuse

Reuse the normalization already implemented in:

`supabase/functions/bybit-demo-live-snapshot/index.ts`

Do not duplicate dashboard/account models unless required. Extract shared normalization/signing code if doing so reduces divergence safely.

## ChatGPT control surface

The ChatGPT-facing operation is conceptually:

`get_bybit_control_snapshot()`

It performs no mutation and returns the canonical snapshot above.

The control panel can render:

- Equity / available balance
- positions
- Entry / Mark
- unrealized PnL
- SL / TP
- liquidation
- open orders
- portfolio open risk
- snapshot age / stale indicator

A ChatGPT UI is a view over this source of truth, not the source of truth itself.

## Freshness

The backend may cache briefly to avoid unnecessary Bybit calls. Every response MUST include `checked_at` and enough metadata for the client to identify stale data. Never label stale/cached data as real-time.

## Acceptance gates

1. Read-only credential is independently verified.
2. Runtime account identity matches the intended AI sub-account.
3. XRP/DOGE (while still open) can be reconciled against Bybit itself; if they have closed, reconcile against position/order history instead.
4. SL/TP and liquidation values are read from Bybit, not reconstructed by the UI.
5. A write-endpoint test proves mutation attempts are rejected before network execution.
6. Existing ALGOBOT spot-only/live-canary tests remain green.
7. No secret appears in source, logs, artifacts, or API responses.
8. No merge/release until validation is complete.

## Out of scope

- New trading strategy
- Futures execution by ALGOBOT
- Autonomous trade approval
- New standalone website/dashboard
- Changes to existing risk limits
