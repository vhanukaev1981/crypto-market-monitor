import test from 'node:test';
import assert from 'node:assert/strict';
import * as quality from '../algo/hourly-data-quality.mjs';

function c(hour, close, volume=10) {
  return {time:new Date(Date.parse('2026-01-01T00:00:00Z')+hour*3600000).toISOString(),open:close,high:close+1,low:close-1,close,volume};
}

function canonicalC(hour,{open=100,high=102,low=99,close=101,volume=10,synthetic=false}={}) {
  return {time:new Date(Date.parse('2024-01-01T00:00:00Z')+hour*3600000).toISOString(),open,high,low,close,volume,...(synthetic?{synthetic:true}:{})};
}

test('fills a one-hour gap conservatively with previous close and zero volume', () => {
  const r=quality.repairMinorHourlyGaps([c(0,100),c(2,102)],{maxGapHours:3});
  assert.equal(r.gapsFilled,1);
  assert.equal(r.candles.length,3);
  assert.deepEqual(r.candles[1],{
    time:'2026-01-01T01:00:00.000Z',open:100,high:100,low:100,close:100,volume:0,synthetic:true
  });
});

test('rejects a gap larger than configured tolerance', () => {
  assert.throws(()=>quality.repairMinorHourlyGaps([c(0,100),c(5,105)],{maxGapHours:3}),/HOURLY_GAP_TOO_LARGE/);
});

test('rejects duplicate or backward timestamps', () => {
  assert.throws(()=>quality.repairMinorHourlyGaps([c(1,101),c(1,101)],{maxGapHours:3}),/NON_MONOTONIC_HOURLY_DATA/);
});

test('repair rejects hourly input that is not aligned even when it contains one candle', () => {
  const bad={...c(0,100),time:'2026-01-01T00:30:00.000Z'};
  assert.throws(()=>quality.repairMinorHourlyGaps([bad],{maxGapHours:3}),/MISALIGNED_HOURLY_DATA/);
});

test('repair rejects invalid prices volume and OHLC before synthesizing data', () => {
  for (const bad of [
    c(0,0),
    c(0,100,-1),
    {...c(0,100),high:99},
  ]) {
    assert.throws(()=>quality.repairMinorHourlyGaps([bad],{maxGapHours:3}),/INVALID_HOURLY_(PRICE|VOLUME|OHLC)/);
  }
});

test('exports a strict canonical hourly validator', () => {
  assert.equal(typeof quality.validateStrictHourlyCandles,'function');
});

test('accepts exact contiguous canonical candles and returns provenance-grade metadata', () => {
  const input=[canonicalC(0),canonicalC(1,{open:101,high:103,low:100,close:102,volume:12})];
  const r=quality.validateStrictHourlyCandles(input,{
    expectedStartTime:'2024-01-01T00:00:00.000Z',
    expectedEndTime:'2024-01-01T01:00:00.000Z',
  });
  assert.deepEqual(r.metadata,{
    candleCount:2,
    first:'2024-01-01T00:00:00.000Z',
    last:'2024-01-01T01:00:00.000Z',
    gapCount:0,
    syntheticCount:0,
  });
  assert.deepEqual(r.candles,input);
});

test('rejects an empty canonical dataset', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([]),/EMPTY_HOURLY_DATA/);
});

test('fails closed on any missing canonical hour without synthetic repair', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(0),canonicalC(2)]),/HOURLY_GAP:1/);
});

test('rejects canonical timestamps that are not aligned to an exact UTC hour', () => {
  const bad={...canonicalC(1),time:'2024-01-01T01:30:00.000Z'};
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(0),bad]),/MISALIGNED_HOURLY_DATA/);
});

test('rejects synthetic candles from canonical Spot evidence', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(0),canonicalC(1,{synthetic:true})]),/SYNTHETIC_CANDLE_NOT_ALLOWED/);
});

test('rejects impossible OHLC geometry in canonical candles', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(0,{open:100,high:100,low:99,close:101,volume:10})]),/INVALID_HOURLY_OHLC/);
});

test('rejects non-positive canonical prices', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(0,{open:0,high:102,low:0,close:101,volume:10})]),/INVALID_HOURLY_PRICE/);
});

test('rejects negative canonical volume', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(0,{volume:-1})]),/INVALID_HOURLY_VOLUME/);
});

test('rejects duplicate or backward canonical timestamps', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(1),canonicalC(1)]),/NON_MONOTONIC_HOURLY_DATA/);
});

test('rejects a canonical dataset whose first candle misses the required boundary', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(1),canonicalC(2)],{expectedStartTime:'2024-01-01T00:00:00.000Z'}),/UNEXPECTED_FIRST_HOURLY_CANDLE/);
});

test('rejects a canonical dataset whose last candle misses the required boundary', () => {
  assert.throws(()=>quality.validateStrictHourlyCandles([canonicalC(0),canonicalC(1)],{expectedEndTime:'2024-01-01T02:00:00.000Z'}),/UNEXPECTED_LAST_HOURLY_CANDLE/);
});
