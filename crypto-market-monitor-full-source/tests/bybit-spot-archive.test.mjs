import test from 'node:test';
import assert from 'node:assert/strict';
import { monthKeys, mergeHourlyCandleChunks } from '../algo/bybit-spot-archive.mjs';

test('monthKeys returns inclusive chronological YYYY-MM sequence',()=>{
  assert.deepEqual(monthKeys('2024-11','2025-02'),['2024-11','2024-12','2025-01','2025-02']);
});

test('mergeHourlyCandleChunks deduplicates identical boundary candles and preserves chronology',()=>{
  const a=[{time:'2024-12-31T23:00:00.000Z',open:1,high:2,low:1,close:2,volume:3}];
  const b=[{...a[0]},{time:'2025-01-01T00:00:00.000Z',open:2,high:3,low:2,close:3,volume:4}];
  const out=mergeHourlyCandleChunks([a,b]);
  assert.equal(out.length,2);
  assert.equal(out[1].time,'2025-01-01T00:00:00.000Z');
});

test('mergeHourlyCandleChunks fails closed on conflicting duplicate timestamps',()=>{
  const a=[{time:'2025-01-01T00:00:00.000Z',open:1,high:2,low:1,close:2,volume:3}];
  const b=[{time:'2025-01-01T00:00:00.000Z',open:1,high:2,low:1,close:1.9,volume:3}];
  assert.throws(()=>mergeHourlyCandleChunks([a,b]),/CONFLICTING_HOURLY_DUPLICATE/);
});
