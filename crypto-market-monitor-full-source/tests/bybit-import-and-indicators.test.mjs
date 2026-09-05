import test from 'node:test';
import assert from 'node:assert/strict';
import { tradesCsvToHourlyCandles } from '../algo/bybit-trade-import.mjs';
import { emaSeries, smaSeries, atrSeries, rsiSeries, adxSeries } from '../algo/indicators.mjs';

test('imports modern Bybit spot trade CSV and aggregates UTC 1H OHLCV', () => {
  const csv = `id,timestamp,price,volume,side,rpi\na,1767225600000,100,2,Buy,0\nb,1767227400000,105,3,Sell,0\nc,1767229199000,98,4,Buy,0\nd,1767229200000,110,1,Buy,0\n`;
  const out = tradesCsvToHourlyCandles(csv);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { time:'2026-01-01T00:00:00.000Z', open:100, high:105, low:98, close:98, volume:9 });
  assert.deepEqual(out[1], { time:'2026-01-01T01:00:00.000Z', open:110, high:110, low:110, close:110, volume:1 });
});

test('imports legacy size-based trade CSV with second timestamps', () => {
  const csv = `timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional\n1767225600,BTCUSDT,Buy,1.5,100,PlusTick,x,0,0,0\n1767225660,BTCUSDT,Sell,0.5,101,MinusTick,y,0,0,0\n`;
  const out = tradesCsvToHourlyCandles(csv);
  assert.equal(out[0].volume, 2);
  assert.equal(out[0].close, 101);
});

test('EMA and SMA of a constant series converge exactly to the constant', () => {
  const xs = Array(30).fill(42);
  assert.equal(emaSeries(xs, 10).at(-1), 42);
  assert.equal(smaSeries(xs, 10).at(-1), 42);
});

test('ATR of constant-range candles is stable', () => {
  const c = Array.from({length:40}, ()=>({high:101, low:99, close:100, open:100}));
  assert.ok(Math.abs(atrSeries(c, 14).at(-1) - 2) < 1e-9);
});

test('RSI approaches 100 on a strictly rising series', () => {
  const xs = Array.from({length:40}, (_,i)=>100+i);
  assert.ok(rsiSeries(xs, 14).at(-1) > 99);
});

test('ADX is strong on a clean monotonic trend', () => {
  const c = Array.from({length:80}, (_,i)=>({high:102+i, low:100+i, close:101+i, open:100.5+i}));
  assert.ok(adxSeries(c, 14).at(-1) > 80);
});
