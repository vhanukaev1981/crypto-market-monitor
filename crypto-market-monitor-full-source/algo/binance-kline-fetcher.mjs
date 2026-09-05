const SYMBOL_RE = /^[A-Z0-9]{3,20}$/;
const INTERVALS = new Set(['1s','1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']);

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function fetchBinanceSpotKlines({
  symbol,
  startTime,
  endTime,
  interval='1h',
  pageLimit=1000,
  baseUrl='https://data-api.binance.vision',
  fetchImpl=globalThis.fetch,
  sleepMs=40,
}={}) {
  if (!SYMBOL_RE.test(symbol ?? '')) throw new Error('INVALID_SYMBOL');
  if (!INTERVALS.has(String(interval))) throw new Error('INVALID_INTERVAL');
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime < startTime) throw new Error('INVALID_TIME_RANGE');
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000) throw new Error('INVALID_PAGE_LIMIT');
  if (typeof baseUrl !== 'string' || !/^https:\/\//.test(baseUrl)) throw new Error('INVALID_BASE_URL');
  if (typeof fetchImpl !== 'function') throw new Error('INVALID_FETCH');

  const rows = new Map();
  let cursorStart = Math.floor(startTime);
  let guard = 0;

  while (cursorStart <= endTime) {
    if (++guard > 10000) throw new Error('PAGINATION_GUARD');
    const qs = new URLSearchParams({symbol,interval:String(interval),startTime:String(cursorStart),endTime:String(Math.floor(endTime)),limit:String(pageLimit)});
    const url = `${baseUrl.replace(/\/$/,'')}/api/v3/klines?${qs}`;
    const res = await fetchImpl(url);
    if (!res?.ok) throw new Error(`BINANCE_HTTP_ERROR:${res?.status ?? 'UNKNOWN'}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('BINANCE_API_ERROR');
    if (list.length === 0) break;

    let maxTs = -Infinity;
    for (const item of list) {
      if (!Array.isArray(item) || item.length < 6) throw new Error('INVALID_BINANCE_KLINE_ROW');
      const [tsRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = item;
      const timeMs=Number(tsRaw), open=Number(openRaw), high=Number(highRaw), low=Number(lowRaw), close=Number(closeRaw), volume=Number(volumeRaw);
      if (![timeMs,open,high,low,close,volume].every(Number.isFinite) || timeMs <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) throw new Error('INVALID_BINANCE_KLINE_ROW');
      maxTs = Math.max(maxTs,timeMs);
      if (timeMs < startTime || timeMs > endTime) continue;
      rows.set(timeMs,{timeMs,time:new Date(timeMs).toISOString(),open,high,low,close,volume});
    }
    if (!Number.isFinite(maxTs) || maxTs >= endTime) break;
    const nextStart=maxTs+1;
    if (nextStart <= cursorStart) throw new Error('PAGINATION_STALLED');
    cursorStart=nextStart;
    await sleep(sleepMs);
  }
  return [...rows.values()].sort((a,b)=>a.timeMs-b.timeMs);
}
