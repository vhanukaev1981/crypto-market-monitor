import readline from 'node:readline';

function toMs(raw){
  const x=Number(raw);
  if(!Number.isFinite(x)||x<=0) throw new Error('INVALID_TIMESTAMP');
  return x<1e12?x*1000:x;
}

function parseHeader(line){
  return line.split(',').map(x=>x.trim().toLowerCase());
}

export async function tradesStreamToHourlyCandles(readable,{symbol,allowImplicitSymbol=false}={}){
  if(!readable || typeof readable[Symbol.asyncIterator]!=='function') throw new Error('INVALID_STREAM');
  if(!/^[A-Z0-9]{3,20}$/.test(symbol??'')) throw new Error('INVALID_SYMBOL');
  if(typeof allowImplicitSymbol!=='boolean') throw new Error('INVALID_IMPLICIT_SYMBOL_POLICY');

  const HOUR=3600000;
  const out=[];
  let indexes=null;
  let lastTradeMs=-Infinity;
  let currentHour=null;
  let candle=null;

  const flush=()=>{
    if(candle) out.push(candle);
    candle=null;
  };

  const rl=readline.createInterface({input:readable,crlfDelay:Infinity});
  for await (const rawLine of rl){
    const line=rawLine.trim();
    if(!line) continue;
    const maybeHeader=parseHeader(line);
    if(maybeHeader.includes('timestamp') && maybeHeader.includes('price') && (maybeHeader.includes('size')||maybeHeader.includes('volume'))){
      const ts=maybeHeader.indexOf('timestamp');
      const sym=maybeHeader.indexOf('symbol');
      const price=maybeHeader.indexOf('price');
      const size=maybeHeader.includes('size')?maybeHeader.indexOf('size'):maybeHeader.indexOf('volume');
      if(ts<0||price<0||size<0) throw new Error('UNSUPPORTED_BYBIT_TRADE_CSV');
      if(sym<0&&!allowImplicitSymbol) throw new Error('IMPLICIT_SYMBOL_NOT_ALLOWED');
      indexes={ts,sym,price,size};
      continue;
    }
    if(!indexes) throw new Error('MISSING_HEADER');
    const cols=line.split(',').map(x=>x.trim());
    const tradeSymbol=indexes.sym>=0?cols[indexes.sym]:symbol;
    if(tradeSymbol!==symbol) throw new Error(`UNEXPECTED_SYMBOL:${tradeSymbol}`);
    const t=toMs(cols[indexes.ts]);
    if(t<lastTradeMs) throw new Error('NON_MONOTONIC_TRADE_TIME');
    lastTradeMs=t;
    const price=Number(cols[indexes.price]);
    const volume=Number(cols[indexes.size]);
    if(!Number.isFinite(price)||price<=0||!Number.isFinite(volume)||volume<0) throw new Error('INVALID_TRADE_ROW');
    const hour=Math.floor(t/HOUR)*HOUR;
    if(currentHour===null || hour!==currentHour){
      if(currentHour!==null && hour<currentHour) throw new Error('NON_MONOTONIC_HOUR');
      flush();
      currentHour=hour;
      candle={time:new Date(hour).toISOString(),open:price,high:price,low:price,close:price,volume:0};
    }
    candle.high=Math.max(candle.high,price);
    candle.low=Math.min(candle.low,price);
    candle.close=price;
    candle.volume+=volume;
  }
  flush();
  return out;
}
