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

export function validateStrictHourlyCandles(candles,{expectedStartTime=null,expectedEndTime=null}={}) {
  if (!Array.isArray(candles)) throw new Error('INVALID_HOURLY_DATA');
  if (candles.length===0) throw new Error('EMPTY_HOURLY_DATA');
  const rows=candles.map(normalize);
  if (rows.some(row=>row.synthetic)) throw new Error('SYNTHETIC_CANDLE_NOT_ALLOWED');
  if (rows.some(row=>[row.open,row.high,row.low,row.close].some(v=>v<=0))) throw new Error('INVALID_HOURLY_PRICE');
  if (rows.some(row=>row.volume<0)) throw new Error('INVALID_HOURLY_VOLUME');
  if (rows.some(row=>row.high<Math.max(row.open,row.close) || row.low>Math.min(row.open,row.close) || row.high<row.low)) throw new Error('INVALID_HOURLY_OHLC');
  if (rows.some(row=>row.t%HOUR_MS!==0)) throw new Error('MISALIGNED_HOURLY_DATA');
  for (let i=1;i<rows.length;i++) {
    const diff=rows[i].t-rows[i-1].t;
    if (diff<=0) throw new Error('NON_MONOTONIC_HOURLY_DATA');
    if (diff>HOUR_MS && diff%HOUR_MS===0) throw new Error(`HOURLY_GAP:${diff/HOUR_MS-1}`);
  }
  if (expectedStartTime!=null) {
    const expectedStartMs=Date.parse(expectedStartTime);
    if (!Number.isFinite(expectedStartMs)) throw new Error('INVALID_EXPECTED_START_TIME');
    if (rows[0].t!==expectedStartMs) throw new Error(`UNEXPECTED_FIRST_HOURLY_CANDLE:${rows[0].time}`);
  }
  if (expectedEndTime!=null) {
    const expectedEndMs=Date.parse(expectedEndTime);
    if (!Number.isFinite(expectedEndMs)) throw new Error('INVALID_EXPECTED_END_TIME');
    if (rows.at(-1).t!==expectedEndMs) throw new Error(`UNEXPECTED_LAST_HOURLY_CANDLE:${rows.at(-1).time}`);
  }
  const normalized=rows.map(({t,...rest})=>rest);
  return {
    candles:normalized,
    metadata:{
      candleCount:normalized.length,
      first:normalized[0]?.time??null,
      last:normalized.at(-1)?.time??null,
      gapCount:0,
      syntheticCount:normalized.filter(c=>c.synthetic).length,
    },
  };
}
