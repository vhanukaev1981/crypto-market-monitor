import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBinanceSpotKlines } from '../algo/binance-kline-fetcher.mjs';

function response(list, status=200) {
  return { ok: status >= 200 && status < 300, status, json: async()=>list };
}

test('paginates forward, deduplicates and returns ascending 1H candles', async () => {
  const calls=[];
  const pages=[
    response([
      [1000,'10','11','9','10.5','1',1999],
      [2000,'20','21','19','20.5','2',2999],
    ]),
    response([
      [2000,'20','21','19','20.5','2',2999],
      [3000,'30','31','29','30.5','3',3999],
    ]),
  ];
  const fetchImpl=async url=>{ calls.push(String(url)); return pages.shift() ?? response([]); };
  const out=await fetchBinanceSpotKlines({symbol:'BTCUSDT',startTime:1000,endTime:3000,interval:'1h',pageLimit:2,fetchImpl,sleepMs:0});
  assert.deepEqual(out.map(x=>x.timeMs),[1000,2000,3000]);
  assert.equal(calls.length,2);
  assert.deepEqual(out[0],{timeMs:1000,time:'1970-01-01T00:00:01.000Z',open:10,high:11,low:9,close:10.5,volume:1});
});

test('fails closed on Binance API HTTP errors', async () => {
  const fetchImpl=async()=>response({code:-1000,msg:'bad'},429);
  await assert.rejects(()=>fetchBinanceSpotKlines({symbol:'BTCUSDT',startTime:1000,endTime:3000,fetchImpl,sleepMs:0}),/BINANCE_HTTP_ERROR:429/);
});

test('rejects unsafe symbols and unsupported intervals', async () => {
  await assert.rejects(()=>fetchBinanceSpotKlines({symbol:'BTC/USDT?x=1',startTime:1000,endTime:3000,fetchImpl:async()=>response([]),sleepMs:0}),/INVALID_SYMBOL/);
  await assert.rejects(()=>fetchBinanceSpotKlines({symbol:'BTCUSDT',startTime:1000,endTime:3000,interval:'7h',fetchImpl:async()=>response([]),sleepMs:0}),/INVALID_INTERVAL/);
});
