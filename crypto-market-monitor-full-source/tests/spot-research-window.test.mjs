import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpotResearchWindow } from '../algo/spot-research-window.mjs';

test('allows canonical Spot development window through 2024-12',()=>{
  assert.deepEqual(assertSpotResearchWindow({startMonth:'2022-11',endMonth:'2024-12'}),{startMonth:'2022-11',endMonth:'2024-12',oosLocked:true});
});

test('rejects any research request that touches blind 2025+ OOS',()=>{
  assert.throws(()=>assertSpotResearchWindow({startMonth:'2022-11',endMonth:'2025-01'}),/OOS_WINDOW_LOCKED/);
});

test('rejects pre-archive or inverted ranges',()=>{
  assert.throws(()=>assertSpotResearchWindow({startMonth:'2022-10',endMonth:'2024-12'}),/SPOT_ARCHIVE_START_EXCEEDED/);
  assert.throws(()=>assertSpotResearchWindow({startMonth:'2024-12',endMonth:'2024-01'}),/INVALID_MONTH_RANGE/);
});
