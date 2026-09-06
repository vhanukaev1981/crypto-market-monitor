function parseCsvLine(line) {
  return line.split(',').map(v => v.trim());
}

function toMs(raw) {
  const x = Number(raw);
  if (!Number.isFinite(x) || x <= 0) throw new Error('INVALID_TIMESTAMP');
  return x < 1e12 ? x * 1000 : x;
}

export function tradesCsvToHourlyCandles(csv) {
  if (typeof csv !== 'string' || !csv.trim()) throw new Error('INVALID_CSV');
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map(x => x.toLowerCase());
  const tsIdx = header.indexOf('timestamp');
  const priceIdx = header.indexOf('price');
  const volumeIdx = header.indexOf('volume') >= 0 ? header.indexOf('volume') : header.indexOf('size');
  if (tsIdx < 0 || priceIdx < 0 || volumeIdx < 0) throw new Error('UNSUPPORTED_BYBIT_TRADE_CSV');

  const trades = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const t = toMs(cols[tsIdx]);
    const price = Number(cols[priceIdx]);
    const volume = Number(cols[volumeIdx]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(volume) || volume < 0) throw new Error('INVALID_TRADE_ROW');
    trades.push({ t, price, volume });
  }
  trades.sort((a,b)=>a.t-b.t);

  const HOUR = 3600000;
  const buckets = new Map();
  for (const tr of trades) {
    const start = Math.floor(tr.t / HOUR) * HOUR;
    let b = buckets.get(start);
    if (!b) {
      b = { time:new Date(start).toISOString(), open:tr.price, high:tr.price, low:tr.price, close:tr.price, volume:0 };
      buckets.set(start,b);
    }
    b.high = Math.max(b.high, tr.price);
    b.low = Math.min(b.low, tr.price);
    b.close = tr.price;
    b.volume += tr.volume;
  }
  return [...buckets.values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
}
