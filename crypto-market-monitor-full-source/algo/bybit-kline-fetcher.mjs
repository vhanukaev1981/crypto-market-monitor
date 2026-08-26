const SYMBOL_RE = /^[A-Z0-9]{3,20}$/;
const INTERVAL_RE = /^(1|3|5|15|30|60|120|240|360|720|D|W|M)$/;

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function fetchBybitKlines({
  symbol,
  startTime,
  endTime,
  interval='60',
  category='spot',
  pageLimit=1000,
  baseUrl='https://api.bybit.com',
  fetchImpl=globalThis.fetch,
  sleepMs=60,
}={}) {
  if (!SYMBOL_RE.test(symbol ?? '')) throw new Error('INVALID_SYMBOL');
  if (!INTERVAL_RE.test(String(interval))) throw new Error('INVALID_INTERVAL');
  if (category !== 'spot') throw new Error('INVALID_CATEGORY');
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime < startTime) throw new Error('INVALID_TIME_RANGE');
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000) throw new Error('INVALID_PAGE_LIMIT');
  if (typeof fetchImpl !== 'function') throw new Error('INVALID_FETCH');

  const rows = new Map();
  let cursorEnd = Math.floor(endTime);
  let guard = 0;

  while (cursorEnd >= startTime) {
    if (++guard > 10000) throw new Error('PAGINATION_GUARD');
    const qs = new URLSearchParams({category,symbol,interval:String(interval),end:String(cursorEnd),limit:String(pageLimit)});
    const url = `${baseUrl.replace(/\/$/,'')}/v5/market/kline?${qs}`;
    const res = await fetchImpl(url);
    if (!res?.ok) throw new Error(`BYBIT_HTTP_ERROR:${res?.status ?? 'UNKNOWN'}`);
    const body = await res.json();
    if (body?.retCode !== 0) throw new Error(`BYBIT_API_ERROR:${body?.retCode}:${body?.retMsg ?? ''}`);
    const list = body?.result?.list;
    if (!Array.isArray(list) || list.length === 0) break;

    let minTs = Infinity;
    for (const item of list) {
      const [tsRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = item;
      const timeMs = Number(tsRaw);
      const open = Number(openRaw), high = Number(highRaw), low = Number(lowRaw), close = Number(closeRaw), volume = Number(volumeRaw);
      if (![timeMs,open,high,low,close,volume].every(Number.isFinite)) throw new Error('INVALID_BYBIT_KLINE_ROW');
      minTs = Math.min(minTs,timeMs);
      if (timeMs < startTime || timeMs > endTime) continue;
      rows.set(timeMs,{timeMs,time:new Date(timeMs).toISOString(),open,high,low,close,volume});
    }
    if (!Number.isFinite(minTs) || minTs <= startTime) break;
    const nextEnd = minTs - 1;
    if (nextEnd >= cursorEnd) throw new Error('PAGINATION_STALLED');
    cursorEnd = nextEnd;
    await sleep(sleepMs);
  }

  return [...rows.values()].sort((a,b)=>a.timeMs-b.timeMs);
}
