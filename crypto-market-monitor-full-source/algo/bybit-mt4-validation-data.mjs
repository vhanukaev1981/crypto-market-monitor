import { parseBybitMt4Klines15m, aggregate15mTo1h } from './bybit-mt4-kline-importer.mjs';
import { repairMinorHourlyGaps } from './hourly-data-quality.mjs';

export function prepareBybitMt4Hourly(text,{maxGapHours=3}={}) {
  const rows15m=parseBybitMt4Klines15m(text);
  const native1h=aggregate15mTo1h(rows15m);
  const repaired=repairMinorHourlyGaps(native1h,{maxGapHours});
  return {
    raw15mCount:rows15m.length,
    native1hCount:native1h.length,
    candles:repaired.candles,
    gapsFilled:repaired.gapsFilled,
    gapEvents:repaired.gapEvents,
  };
}
