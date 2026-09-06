function assertSeries(values) {
  if (!Array.isArray(values)) throw new Error('INVALID_SERIES');
  for (const value of values) if (!Number.isFinite(value)) throw new Error('INVALID_SERIES_VALUE');
}

function assertLookback(lookback) {
  if (!Number.isInteger(lookback) || lookback < 1) throw new Error('INVALID_LOOKBACK');
}

export function trendEfficiency(values, lookback) {
  assertSeries(values);
  assertLookback(lookback);
  if (values.length < lookback + 1) return null;
  const start = values.length - 1 - lookback;
  const end = values.length - 1;
  const net = Math.abs(values[end] - values[start]);
  let path = 0;
  for (let i = start + 1; i <= end; i++) path += Math.abs(values[i] - values[i - 1]);
  if (path === 0) return 0;
  return net / path;
}

export function positiveSlopeShare(values, lookback) {
  assertSeries(values);
  assertLookback(lookback);
  if (values.length < lookback + 1) return null;
  const start = values.length - lookback;
  let positive = 0;
  for (let i = start; i < values.length; i++) if (values[i] > values[i - 1]) positive++;
  return positive / lookback;
}

export function finiteDelta(values, index, lookback) {
  assertSeries(values);
  assertLookback(lookback);
  if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new Error('INVALID_INDEX');
  if (index - lookback < 0) return null;
  return values[index] - values[index - lookback];
}
