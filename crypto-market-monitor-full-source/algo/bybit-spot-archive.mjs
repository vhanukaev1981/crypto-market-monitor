function parseMonthKey(key){
  const m=String(key).match(/^(\d{4})-(\d{2})$/);
  if(!m) throw new Error('INVALID_MONTH_KEY');
  const y=Number(m[1]), mo=Number(m[2]);
  if(mo<1||mo>12) throw new Error('INVALID_MONTH_KEY');
  return {y,mo};
}

export function monthKeys(start,end){
  const a=parseMonthKey(start), b=parseMonthKey(end);
  const startN=a.y*12+(a.mo-1), endN=b.y*12+(b.mo-1);
  if(endN<startN) throw new Error('INVALID_MONTH_RANGE');
  const out=[];
  for(let n=startN;n<=endN;n++){
    const y=Math.floor(n/12), mo=(n%12)+1;
    out.push(`${y}-${String(mo).padStart(2,'0')}`);
  }
  return out;
}

export function spotArchiveUrl({symbol,month}={}){
  if(!/^[A-Z0-9]{3,20}$/.test(symbol??'')) throw new Error('INVALID_SYMBOL');
  parseMonthKey(month);
  return `https://public.bybit.com/spot/${symbol}/${symbol}-${month}.csv.gz`;
}

function validateCandle(c){
  const t=Date.parse(c?.time);
  const open=Number(c?.open), high=Number(c?.high), low=Number(c?.low), close=Number(c?.close), volume=Number(c?.volume);
  if(!Number.isFinite(t)||![open,high,low,close,volume].every(Number.isFinite)||open<=0||high<=0||low<=0||close<=0||volume<0) throw new Error('INVALID_HOURLY_CANDLE');
  if(high<Math.max(open,close,low)||low>Math.min(open,close,high)) throw new Error('INVALID_HOURLY_CANDLE');
  return {time:new Date(t).toISOString(),open,high,low,close,volume};
}

function same(a,b){
  return a.open===b.open&&a.high===b.high&&a.low===b.low&&a.close===b.close&&a.volume===b.volume;
}

export function mergeHourlyCandleChunks(chunks){
  if(!Array.isArray(chunks)) throw new Error('INVALID_CHUNKS');
  const out=[];
  let prevMs=-Infinity, prev=null;
  for(const chunk of chunks){
    if(!Array.isArray(chunk)) throw new Error('INVALID_CHUNK');
    for(const raw of chunk){
      const row=validateCandle(raw);
      const ms=Date.parse(row.time);
      if(ms<prevMs) throw new Error('NON_ASCENDING_HOURLY_TIMESTAMP');
      if(ms===prevMs){
        if(!prev||!same(row,prev)) throw new Error('CONFLICTING_HOURLY_DUPLICATE');
        continue;
      }
      out.push(row);
      prevMs=ms;
      prev=row;
    }
  }
  return out;
}
