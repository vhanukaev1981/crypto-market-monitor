import test from 'node:test';
import assert from 'node:assert/strict';
import { findHourlyGaps, splitContiguousHourlySegments, selectEligibleHourlySegments } from '../algo/hourly-segments.mjs';

function c(h) {
  return {time:new Date(Date.UTC(2024,0,1,h)).toISOString(),open:100,high:101,low:99,close:100,volume:1};
}

test('reports exact missing-hour boundaries and counts', () => {
  const gaps=findHourlyGaps([c(0),c(1),c(5),c(6),c(10)]);
  assert.deepEqual(gaps,[
    {after:c(1).time,before:c(5).time,missingHours:3},
    {after:c(6).time,before:c(10).time,missingHours:3},
  ]);
});

test('splits candles into contiguous hourly segments without fabricating data', () => {
  const segments=splitContiguousHourlySegments([c(0),c(1),c(5),c(6),c(7)]);
  assert.equal(segments.length,2);
  assert.deepEqual(segments.map(s=>s.length),[2,3]);
  assert.equal(segments[0][0].time,c(0).time);
  assert.equal(segments[1][0].time,c(5).time);
});

test('selects only segments with enough hourly history for the configured warmup', () => {
  const short=Array.from({length:4799},(_,i)=>c(i));
  const long=Array.from({length:4800},(_,i)=>c(6000+i));
  const selected=selectEligibleHourlySegments([short,long],{minHours:4800});
  assert.equal(selected.length,1);
  assert.equal(selected[0].length,4800);
});

test('rejects duplicate or backward timestamps', () => {
  assert.throws(()=>findHourlyGaps([c(1),c(1)]),/NON_MONOTONIC_HOURLY_DATA/);
});
