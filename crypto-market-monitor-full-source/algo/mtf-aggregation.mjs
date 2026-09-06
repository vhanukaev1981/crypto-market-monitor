const HOUR_MS = 60 * 60 * 1000;

function normalizeCandle(c) {
  const t = Date.parse(c?.time);
  const open = Number(c?.open);
  const high = Number(c?.high);
  const low = Number(c?.low);
  const close = Number(c?.close);
  const volume = Number(c?.volume ?? 0);
  if (!Number.isFinite(t) || ![open, high, low, close, volume].every(Number.isFinite)) {
    throw new Error('INVALID_CANDLE');
  }
  return { t, time: new Date(t).toISOString(), open, high, low, close, volume };
}

export function aggregateCompletedCandles(candles, { timeframeHours, asOf } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  if (!Number.isInteger(timeframeHours) || timeframeHours <= 0 || 24 % timeframeHours !== 0) {
    throw new Error('INVALID_TIMEFRAME');
  }
  const rows = candles.map(normalizeCandle).sort((a,b) => a.t - b.t);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].t - rows[i-1].t !== HOUR_MS) throw new Error('NON_CONTIGUOUS_1H_DATA');
  }
  const cutoff = asOf == null ? Infinity : Date.parse(asOf);
  if (!Number.isFinite(cutoff) && cutoff !== Infinity) throw new Error('INVALID_ASOF');
  const bucketMs = timeframeHours * HOUR_MS;
  const groups = new Map();
  for (const row of rows) {
    const bucketStart = Math.floor(row.t / bucketMs) * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    if (bucketEnd > cutoff) continue;
    const arr = groups.get(bucketStart) ?? [];
    arr.push(row);
    groups.set(bucketStart, arr);
  }
  const out = [];
  for (const [bucketStart, arr] of [...groups.entries()].sort((a,b)=>a[0]-b[0])) {
    if (arr.length !== timeframeHours) continue;
    const expectedTimes = Array.from({length: timeframeHours}, (_,i)=>bucketStart + i*HOUR_MS);
    if (!arr.every((r,i)=>r.t === expectedTimes[i])) continue;
    out.push({
      time: new Date(bucketStart).toISOString(),
      open: arr[0].open,
      high: Math.max(...arr.map(r=>r.high)),
      low: Math.min(...arr.map(r=>r.low)),
      close: arr.at(-1).close,
      volume: arr.reduce((s,r)=>s+r.volume,0),
    });
  }
  return out;
}
