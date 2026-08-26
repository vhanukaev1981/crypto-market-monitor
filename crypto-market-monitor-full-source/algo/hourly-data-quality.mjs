const HOUR_MS = 3600000;

function normalize(c) {
  const t=Date.parse(c?.time);
  const open=Number(c?.open), high=Number(c?.high), low=Number(c?.low), close=Number(c?.close), volume=Number(c?.volume);
  if (!Number.isFinite(t) || ![open,high,low,close,volume].every(Number.isFinite)) throw new Error('INVALID_HOURLY_CANDLE');
  return {t,time:new Date(t).toISOString(),open,high,low,close,volume, ...(c?.synthetic ? {synthetic:true} : {})};
}

export function repairMinorHourlyGaps(candles,{maxGapHours=3}={}) {
  if (!Array.isArray(candles) || candles.length===0) return {candles:[],gapsFilled:0,gapEvents:[]};
  if (!Number.isInteger(maxGapHours) || maxGapHours < 0) throw new Error('INVALID_MAX_GAP_HOURS');
  const rows=candles.map(normalize);
  const out=[(({t,...rest})=>rest)(rows[0])];
  let gapsFilled=0;
  const gapEvents=[];
  for (let i=1;i<rows.length;i++) {
    const prev=rows[i-1], cur=rows[i];
    const diff=cur.t-prev.t;
    if (diff <= 0) throw new Error('NON_MONOTONIC_HOURLY_DATA');
    if (diff % HOUR_MS !== 0) throw new Error('MISALIGNED_HOURLY_DATA');
    const missing=diff/HOUR_MS-1;
    if (missing > maxGapHours) throw new Error(`HOURLY_GAP_TOO_LARGE:${missing}`);
    if (missing > 0) {
      gapEvents.push({after:prev.time,before:cur.time,missingHours:missing});
      for (let j=1;j<=missing;j++) {
        const time=new Date(prev.t+j*HOUR_MS).toISOString();
        out.push({time,open:prev.close,high:prev.close,low:prev.close,close:prev.close,volume:0,synthetic:true});
        gapsFilled++;
      }
    }
    const {t,...rest}=cur;
    out.push(rest);
  }
  return {candles:out,gapsFilled,gapEvents};
}
