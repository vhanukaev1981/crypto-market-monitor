function validPeriod(period) {
  if (!Number.isInteger(period) || period <= 0) throw new Error('INVALID_PERIOD');
}

export function smaSeries(values, period) {
  validPeriod(period);
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i=0;i<values.length;i++) {
    const x = Number(values[i]);
    if (!Number.isFinite(x)) throw new Error('INVALID_SERIES');
    sum += x;
    if (i >= period) sum -= Number(values[i-period]);
    if (i >= period-1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values, period) {
  validPeriod(period);
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i=0;i<period;i++) {
    const x = Number(values[i]);
    if (!Number.isFinite(x)) throw new Error('INVALID_SERIES');
    seed += x;
  }
  let ema = seed / period;
  out[period-1] = ema;
  const a = 2/(period+1);
  for (let i=period;i<values.length;i++) {
    const x = Number(values[i]);
    if (!Number.isFinite(x)) throw new Error('INVALID_SERIES');
    ema = a*x + (1-a)*ema;
    out[i] = ema;
  }
  return out;
}

function trueRanges(candles) {
  return candles.map((c,i) => {
    const h=Number(c.high), l=Number(c.low), prev=i>0?Number(candles[i-1].close):null;
    if (![h,l,Number(c.close)].every(Number.isFinite)) throw new Error('INVALID_CANDLES');
    if (i===0) return h-l;
    return Math.max(h-l, Math.abs(h-prev), Math.abs(l-prev));
  });
}

function wilderSeries(values, period) {
  validPeriod(period);
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let s=0;
  for (let i=0;i<period;i++) s += values[i];
  let avg=s/period;
  out[period-1]=avg;
  for (let i=period;i<values.length;i++) {
    avg=((avg*(period-1))+values[i])/period;
    out[i]=avg;
  }
  return out;
}

export function atrSeries(candles, period=14) {
  return wilderSeries(trueRanges(candles), period);
}

export function rsiSeries(values, period=14) {
  validPeriod(period);
  const out=Array(values.length).fill(null);
  if (values.length <= period) return out;
  const gains=Array(values.length).fill(0), losses=Array(values.length).fill(0);
  for (let i=1;i<values.length;i++) {
    const d=Number(values[i])-Number(values[i-1]);
    if (!Number.isFinite(d)) throw new Error('INVALID_SERIES');
    gains[i]=Math.max(d,0); losses[i]=Math.max(-d,0);
  }
  let avgGain=gains.slice(1,period+1).reduce((a,b)=>a+b,0)/period;
  let avgLoss=losses.slice(1,period+1).reduce((a,b)=>a+b,0)/period;
  out[period]=avgLoss===0 ? 100 : 100-(100/(1+avgGain/avgLoss));
  for (let i=period+1;i<values.length;i++) {
    avgGain=((avgGain*(period-1))+gains[i])/period;
    avgLoss=((avgLoss*(period-1))+losses[i])/period;
    out[i]=avgLoss===0 ? 100 : 100-(100/(1+avgGain/avgLoss));
  }
  return out;
}

export function adxSeries(candles, period=14) {
  validPeriod(period);
  const n=candles.length;
  const tr=trueRanges(candles);
  const plusDM=Array(n).fill(0), minusDM=Array(n).fill(0);
  for (let i=1;i<n;i++) {
    const up=Number(candles[i].high)-Number(candles[i-1].high);
    const down=Number(candles[i-1].low)-Number(candles[i].low);
    plusDM[i]=(up>down && up>0)?up:0;
    minusDM[i]=(down>up && down>0)?down:0;
  }
  const atr=wilderSeries(tr,period);
  const p=wilderSeries(plusDM,period), m=wilderSeries(minusDM,period);
  const dx=Array(n).fill(null);
  for (let i=period-1;i<n;i++) {
    if (atr[i] == null || atr[i]===0) continue;
    const pdi=100*p[i]/atr[i], mdi=100*m[i]/atr[i];
    const den=pdi+mdi;
    dx[i]=den===0?0:100*Math.abs(pdi-mdi)/den;
  }
  const out=Array(n).fill(null);
  const firstDx=period-1;
  const firstAdx=firstDx+period-1;
  if (n<=firstAdx) return out;
  let seed=0;
  for (let i=firstDx;i<=firstAdx;i++) seed += dx[i] ?? 0;
  let adx=seed/period;
  out[firstAdx]=adx;
  for (let i=firstAdx+1;i<n;i++) {
    adx=((adx*(period-1))+(dx[i]??0))/period;
    out[i]=adx;
  }
  return out;
}
