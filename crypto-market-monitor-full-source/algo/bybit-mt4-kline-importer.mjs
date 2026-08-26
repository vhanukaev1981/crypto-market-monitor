function parseUtcTimestamp(raw) {
  const m = String(raw).match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) throw new Error('INVALID_MT4_TIMESTAMP');
  const [,y,mo,d,h,mi] = m;
  const ms = Date.UTC(Number(y), Number(mo)-1, Number(d), Number(h), Number(mi));
  return ms;
}

export function parseBybitMt4Klines15m(text) {
  if (typeof text !== 'string') throw new Error('INVALID_MT4_TEXT');
  const out=[];
  let prev=-Infinity;
  for (const rawLine of text.split(/\r?\n/)) {
    const line=rawLine.trim();
    if (!line) continue;
    const parts=line.split(',');
    if (parts.length !== 6) throw new Error('INVALID_MT4_ROW');
    const ms=parseUtcTimestamp(parts[0]);
    if (ms <= prev) throw new Error('DUPLICATE_OR_NON_ASCENDING_MT4_TIMESTAMP');
    prev=ms;
    const [open,high,low,close,volume]=parts.slice(1).map(Number);
    if (![open,high,low,close,volume].every(Number.isFinite) || open<=0 || high<=0 || low<=0 || close<=0 || volume<0 || high<Math.max(open,close,low) || low>Math.min(open,close,high)) throw new Error('INVALID_MT4_OHLCV');
    out.push({time:new Date(ms).toISOString(),open,high,low,close,volume});
  }
  return out;
}

export function aggregate15mTo1h(rows) {
  if (!Array.isArray(rows)) throw new Error('INVALID_MT4_ROWS');
  const out=[];
  for (let i=0;i+3<rows.length;) {
    const first=rows[i];
    const start=Date.parse(first.time);
    const hourStart=Math.floor(start/3600000)*3600000;
    if (start!==hourStart) { i++; continue; }
    const bucket=rows.slice(i,i+4);
    const expected=[0,15,30,45].map(m=>hourStart+m*60000);
    if (bucket.every((r,j)=>Date.parse(r.time)===expected[j])) {
      out.push({
        time:new Date(hourStart).toISOString(),
        open:bucket[0].open,
        high:Math.max(...bucket.map(r=>r.high)),
        low:Math.min(...bucket.map(r=>r.low)),
        close:bucket[3].close,
        volume:bucket.reduce((s,r)=>s+r.volume,0),
      });
      i+=4;
    } else {
      i++;
    }
  }
  return out;
}
