import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpotResearchWindow, spotResearchTimeRange } from '../algo/spot-research-window.mjs';

test('allows canonical Spot development window through 2024-12',()=>{
  assert.deepEqual(assertSpotResearchWindow({startMonth:'2022-11',endMonth:'2024-12'}),{startMonth:'2022-11',endMonth:'2024-12',oosLocked:true});
});

test('rejects any research request that touches blind 2025+ OOS',()=>{
  assert.throws(()=>assertSpotResearchWindow({startMonth:'2022-11',endMonth:'2025-01'}),/OOS_WINDOW_LOCKED/);
  assert.throws(()=>spotResearchTimeRange({startMonth:'2022-11',endMonth:'2025-01'}),/OOS_WINDOW_LOCKED/);
});

test('rejects pre-archive or inverted ranges',()=>{
  assert.throws(()=>assertSpotResearchWindow({startMonth:'2022-10',endMonth:'2024-12'}),/SPOT_ARCHIVE_START_EXCEEDED/);
  assert.throws(()=>assertSpotResearchWindow({startMonth:'2024-12',endMonth:'2024-01'}),/INVALID_MONTH_RANGE/);
});

test('derives exact canonical hourly UTC boundaries and expected candle count',()=>{
  assert.deepEqual(spotResearchTimeRange({startMonth:'2022-11',endMonth:'2024-12'}),{
    startMs:Date.parse('2022-11-01T00:00:00.000Z'),
    endRequestMs:Date.parse('2024-12-31T23:59:59.999Z'),
    expectedFirst:'2022-11-01T00:00:00.000Z',
    expectedLast:'2024-12-31T23:00:00.000Z',
    expectedCandleCount:19008,
  });
});
