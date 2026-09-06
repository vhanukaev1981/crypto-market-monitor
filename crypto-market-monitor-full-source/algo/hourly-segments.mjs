const HOUR_MS = 3600000;

function timestamp(c) {
  const t=Date.parse(c?.time);
  if (!Number.isFinite(t)) throw new Error('INVALID_HOURLY_TIMESTAMP');
  return t;
}

function validateMonotonic(candles) {
  if (!Array.isArray(candles)) throw new Error('INVALID_HOURLY_DATA');
  let prev=-Infinity;
  for (const c of candles) {
    const t=timestamp(c);
    if (t <= prev) throw new Error('NON_MONOTONIC_HOURLY_DATA');
    if (t % HOUR_MS !== 0) throw new Error('MISALIGNED_HOURLY_DATA');
    prev=t;
  }
}

export function findHourlyGaps(candles) {
  validateMonotonic(candles);
  const gaps=[];
  for (let i=1;i<candles.length;i++) {
    const prev=timestamp(candles[i-1]);
    const cur=timestamp(candles[i]);
    const diff=cur-prev;
    if (diff % HOUR_MS !== 0) throw new Error('MISALIGNED_HOURLY_DATA');
    const missing=diff/HOUR_MS-1;
    if (missing > 0) gaps.push({after:candles[i-1].time,before:candles[i].time,missingHours:missing});
  }
  return gaps;
}

export function splitContiguousHourlySegments(candles) {
  validateMonotonic(candles);
  if (candles.length===0) return [];
  const segments=[];
  let current=[candles[0]];
  for (let i=1;i<candles.length;i++) {
    const prev=timestamp(candles[i-1]);
    const cur=timestamp(candles[i]);
    if (cur-prev===HOUR_MS) current.push(candles[i]);
    else {
      segments.push(current);
      current=[candles[i]];
    }
  }
  segments.push(current);
  return segments;
}

export function selectEligibleHourlySegments(segments,{minHours=4800}={}) {
  if (!Array.isArray(segments)) throw new Error('INVALID_SEGMENTS');
  if (!Number.isInteger(minHours) || minHours < 1) throw new Error('INVALID_MIN_HOURS');
  return segments.filter(segment => {
    validateMonotonic(segment);
    if (segment.length===0) return false;
    for (let i=1;i<segment.length;i++) {
      if (timestamp(segment[i])-timestamp(segment[i-1])!==HOUR_MS) throw new Error('NON_CONTIGUOUS_SEGMENT');
    }
    return segment.length >= minHours;
  });
}
