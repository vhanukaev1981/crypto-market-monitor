import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBybitKlines } from '../algo/bybit-kline-fetcher.mjs';

function response(list) {
  return { ok:true, status:200, json: async()=>({retCode:0,retMsg:'OK',result:{list}}) };
}

test('paginates backwards, deduplicates and returns ascending 1H candles', async () => {
  const calls=[];
  const pages=[
    response([['3000','30','31','29','30.5','3','0'],['2000','20','21','19','20.5','2','0']]),
    response([['2000','20','21','19','20.5','2','0'],['1000','10','11','9','10.5','1','0']]),
  ];
  const fetchImpl=async url=>{calls.push(String(url)); return pages.shift() ?? response([])};
  const out=await fetchBybitKlines({symbol:'BTCUSDT',startTime:1000,endTime:3000,pageLimit:2,baseUrls:['https://example.test'],fetchImpl,sleepMs:0});
  assert.equal(calls.length,2);
  assert.deepEqual(out.map(x=>x.timeMs),[1000,2000,3000]);
  assert.deepEqual(out[0],{timeMs:1000,time:'1970-01-01T00:00:01.000Z',open:10,high:11,low:9,close:10.5,volume:1});
});

test('fails closed on conflicting duplicate candles across pages', async () => {
  const pages=[
    response([['3000','30','31','29','30.5','3','0'],['2000','20','21','19','20.5','2','0']]),
    response([['2000','20','22','19','20.5','2','0'],['1000','10','11','9','10.5','1','0']]),
  ];
  const fetchImpl=async()=>pages.shift() ?? response([]);
  await assert.rejects(
    ()=>fetchBybitKlines({symbol:'BTCUSDT',startTime:1000,endTime:3000,pageLimit:2,baseUrls:['https://example.test'],fetchImpl,sleepMs:0}),
    /CONFLICTING_DUPLICATE_KLINE:2000/,
  );
});

test('falls through blocked official Bybit endpoints until one succeeds', async () => {
  const calls=[];
  const fetchImpl=async url=>{
    calls.push(String(url));
    if (String(url).startsWith('https://api.bybit.com/') || String(url).startsWith('https://api.bytick.com/')) return {ok:false,status:403,json:async()=>({})};
    return response([['1000','10','11','9','10.5','1','0']]);
  };
  const out=await fetchBybitKlines({symbol:'BTCUSDT',startTime:1000,endTime:1000,fetchImpl,sleepMs:0});
  assert.equal(out.length,1);
  assert.equal(calls.length,3);
  assert.match(calls[0],/^https:\/\/api\.bybit\.com\//);
  assert.match(calls[1],/^https:\/\/api\.bytick\.com\//);
  assert.match(calls[2],/^https:\/\/api\.bybitglobal\.com\//);
});

test('fails closed on Bybit API retCode errors', async () => {
  const fetchImpl=async()=>({ok:true,status:200,json:async()=>({retCode:10001,retMsg:'bad',result:{list:[]}})});
  await assert.rejects(()=>fetchBybitKlines({symbol:'BTCUSDT',startTime:1000,endTime:3000,baseUrls:['https://example.test'],fetchImpl,sleepMs:0}),/BYBIT_API_ERROR/);
});

test('rejects unsupported symbol input rather than interpolating arbitrary URLs', async () => {
  await assert.rejects(()=>fetchBybitKlines({symbol:'BTC/USDT?x=1',startTime:1000,endTime:3000,fetchImpl:async()=>response([]),sleepMs:0}),/INVALID_SYMBOL/);
});
