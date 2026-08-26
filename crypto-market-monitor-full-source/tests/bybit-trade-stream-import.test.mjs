import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { tradesStreamToHourlyCandles } from '../algo/bybit-trade-stream-import.mjs';

test('aggregates chronological Bybit trade CSV stream into deterministic 1H OHLCV and tolerates repeated headers', async()=>{
  const csv = [
    'timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional',
    '1735689600.000,BTCUSDT,Buy,0.10,100,ZeroPlusTick,a,0,0,0',
    '1735689660.000,BTCUSDT,Sell,0.20,105,MinusTick,b,0,0,0',
    'timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional',
    '1735693140.000,BTCUSDT,Buy,0.30,95,PlusTick,c,0,0,0',
    '1735693200.000,BTCUSDT,Buy,0.40,110,PlusTick,d,0,0,0',
  ].join('\n');
  const out = await tradesStreamToHourlyCandles(Readable.from([csv]), {symbol:'BTCUSDT'});
  assert.equal(out.length,2);
  assert.deepEqual({...out[0],volume:undefined},{time:'2025-01-01T00:00:00.000Z',open:100,high:105,low:95,close:95,volume:undefined});
  assert.ok(Math.abs(out[0].volume-0.6)<1e-12);
  assert.deepEqual(out[1],{time:'2025-01-01T01:00:00.000Z',open:110,high:110,low:110,close:110,volume:0.4});
});

test('rejects out-of-order trades instead of silently rewriting OHLC chronology', async()=>{
  const csv='timestamp,symbol,side,size,price\n1735689660,BTCUSDT,Buy,1,101\n1735689600,BTCUSDT,Buy,1,100\n';
  await assert.rejects(()=>tradesStreamToHourlyCandles(Readable.from([csv]),{symbol:'BTCUSDT'}),/NON_MONOTONIC_TRADE_TIME/);
});

test('rejects cross-symbol contamination', async()=>{
  const csv='timestamp,symbol,side,size,price\n1735689600,ETHUSDT,Buy,1,100\n';
  await assert.rejects(()=>tradesStreamToHourlyCandles(Readable.from([csv]),{symbol:'BTCUSDT'}),/UNEXPECTED_SYMBOL/);
});
