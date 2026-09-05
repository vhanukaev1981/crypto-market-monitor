export function consecutiveTailCount(values, target) {
  if (!Array.isArray(values)) throw new Error('INVALID_SERIES');
  let count=0;
  for (let i=values.length-1;i>=0;i--) {
    if (values[i]!==target) break;
    count++;
  }
  return count;
}

export function transitionCount(values, lookback) {
  if (!Array.isArray(values)) throw new Error('INVALID_SERIES');
  if (!Number.isInteger(lookback) || lookback<1) throw new Error('INVALID_LOOKBACK');
  if (values.length<2) return 0;
  const start=Math.max(1,values.length-lookback);
  let count=0;
  for (let i=start;i<values.length;i++) if (values[i]!==values[i-1]) count++;
  return count;
}

export function relativeSpreadPct(a,b,reference) {
  if (![a,b].every(Number.isFinite)) throw new Error('INVALID_VALUE');
  if (!Number.isFinite(reference) || reference===0) throw new Error('INVALID_REFERENCE');
  return ((a-b)/reference)*100;
}
