import test from 'node:test';
import assert from 'node:assert/strict';
import { trendEfficiency, positiveSlopeShare, finiteDelta } from '../algo/trend-persistence-features.mjs';

test('trend efficiency approaches one on monotonic movement and falls on whipsaw',()=>{
  const mono=Array.from({length:25},(_,i)=>100+i);
  const chop=Array.from({length:25},(_,i)=>100+(i%2?1:-1));
  assert.equal(trendEfficiency(mono,24),1);
  assert.ok(trendEfficiency(chop,24)<0.1);
});

test('positive slope share measures directional persistence',()=>{
  const rising=Array.from({length:25},(_,i)=>i);
  const mixed=[0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0];
  assert.equal(positiveSlopeShare(rising,24),1);
  assert.ok(positiveSlopeShare(mixed,24)>0.45 && positiveSlopeShare(mixed,24)<0.55);
});

test('finite delta returns null until lookback is available',()=>{
  assert.equal(finiteDelta([1,2,3],2,3),null);
  assert.equal(finiteDelta([1,2,3,5],3,2),3);
});
