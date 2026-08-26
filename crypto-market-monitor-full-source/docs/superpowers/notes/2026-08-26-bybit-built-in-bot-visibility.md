# Bybit Built-in Bot Visibility — Implementation Decision

Date: 2026-08-26

During implementation, current Bybit V5 documentation was re-verified before modifying the deployed read-only snapshot function.

## Finding

`GET /v5/strategy/list` is a Strategy API for execution strategies such as TWAP / Iceberg / Chase Order / POV. It is not a canonical account-wide listing API for the user's Spot Grid and DCA bots.

The current V5 rate-limit catalog exposes Spot Grid creation/close/detail and DCA create/close endpoints, but does not document a safe account-wide read endpoint that enumerates both active Spot Grid and DCA bots with their P&L.

## Decision

V1 will NOT add `/v5/strategy/list` to the personal-account snapshot and will NOT deploy a speculative Edge Function change.

V1 will use the already-approved read-only `/v5/asset/asset-overview` data and the existing normalized snapshot/account type breakdown to expose TradingBot account-level equity where available.

Individual Grid/DCA performance remains explicitly unavailable unless a documented, read-only source can identify the specific bot safely. The dashboard must show that state instead of inferring or inventing Grid/DCA P&L from account balances.

This preserves the user's strict credential boundary and the V1 read-only guarantee.
