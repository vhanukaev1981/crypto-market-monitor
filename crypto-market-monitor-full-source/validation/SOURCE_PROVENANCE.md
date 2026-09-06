# ALGO V2 Data Source Provenance

## Canonical market for the target strategy

Target execution venue: Bybit Spot.

Canonical historical source for Spot research and validation:

- `https://public.bybit.com/spot/<SYMBOL>/`
- Trade-level CSV archives are aggregated to 1H OHLCV using the repository's fail-closed streaming importer.

## Derivatives proxy source

`https://public.bybit.com/kline_for_metatrader4/<SYMBOL>/...` is associated with Bybit MT4 / USDT perpetual derivatives and MUST NOT be labeled Spot-native.

All ALGO V2 results produced from `kline_for_metatrader4` are retained as derivatives proxy research only. They may be useful for engine regression, regime research, risk controls, and robustness checks, but they cannot qualify a Spot strategy for Paper or Live trading.

## Research split policy

For BTCUSDT Spot archive work:

- Development / research source window: 2022-11 through 2024-12.
- 2025-01 onward is held out from strategy selection and threshold tuning.
- 2025-01 through the latest fully available closed month is reserved for blind Out-of-Sample validation after a candidate is frozen.
- No OOS outcome may be used to tune the candidate that is being tested on that same OOS window.

## Fail-closed rules

- Cross-symbol rows: reject.
- Non-monotonic trade timestamps: reject.
- Conflicting duplicate hourly candles: reject.
- Missing archive month: reject the run.
- Material hourly gaps: report and segment; do not synthesize large missing ranges.
- Trading logic, sizing, fees, spread, slippage and Risk Engine remain frozen during source-validation work.

## Status

The previous 2020-2024 MT4-derived validation is reclassified as `DERIVATIVES_PROXY_RESEARCH` and is not Spot qualification evidence.
