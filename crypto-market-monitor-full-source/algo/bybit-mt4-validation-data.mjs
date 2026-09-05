import { parseBybitMt4Klines15m, aggregate15mTo1h } from './bybit-mt4-kline-importer.mjs';
import { repairMinorHourlyGaps } from './hourly-data-quality.mjs';

export function prepareBybitMt4Hourly(text,{sourceMinutes=15,maxGapHours=3}={}) {
  if (![15,60].includes(sourceMinutes)) throw new Error('UNSUPPORTED_MT4_SOURCE_MINUTES');
  const sourceRows=parseBybitMt4Klines15m(text);
  let native1h;
  if (sourceMinutes===15) {
    native1h=aggregate15mTo1h(sourceRows);
  } else {
    for (const row of sourceRows) {
      const t=Date.parse(row.time);
      if (!Number.isFinite(t) || t % 3600000 !== 0) throw new Error('MISALIGNED_MT4_60M_TIMESTAMP');
    }
    native1h=sourceRows;
  }
  const repaired=repairMinorHourlyGaps(native1h,{maxGapHours});
  return {
    sourceMinutes,
    rawSourceCount:sourceRows.length,
    native1hCount:native1h.length,
    candles:repaired.candles,
    gapsFilled:repaired.gapsFilled,
    gapEvents:repaired.gapEvents,
  };
}
