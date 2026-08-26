import test from 'node:test';
import assert from 'node:assert/strict';
import { repairMinorHourlyGaps } from '../algo/hourly-data-quality.mjs';

function c(hour, close, volume=10) {
  return {time:new Date(Date.parse('2026-01-01T00:00:00Z')+hour*3600000).toISOString(),open:close,high:close+1,low:close-1,close,volume};
}

test('fills a one-hour gap conservatively with previous close and zero volume', () => {
  const r=repairMinorHourlyGaps([c(0,100),c(2,102)],{maxGapHours:3});
  assert.equal(r.gapsFilled,1);
  assert.equal(r.candles.length,3);
  assert.deepEqual(r.candles[1],{
    time:'2026-01-01T01:00:00.000Z',open:100,high:100,low:100,close:100,volume:0,synthetic:true
  });
});

test('rejects a gap larger than configured tolerance', () => {
  assert.throws(()=>repairMinorHourlyGaps([c(0,100),c(5,105)],{maxGapHours:3}),/HOURLY_GAP_TOO_LARGE/);
});

test('rejects duplicate or backward timestamps', () => {
  assert.throws(()=>repairMinorHourlyGaps([c(1,101),c(1,101)],{maxGapHours:3}),/NON_MONOTONIC_HOURLY_DATA/);
});
