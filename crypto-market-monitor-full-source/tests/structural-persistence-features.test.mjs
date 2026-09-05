import test from 'node:test';
import assert from 'node:assert/strict';
import { consecutiveTailCount, transitionCount, relativeSpreadPct } from '../algo/structural-persistence-features.mjs';

test('consecutive tail count measures current regime age',()=>{
  assert.equal(consecutiveTailCount(['DOWN','UP','UP','UP'],'UP'),3);
  assert.equal(consecutiveTailCount(['UP','UP','DOWN'],'UP'),0);
  assert.equal(consecutiveTailCount([], 'UP'),0);
});

test('transition count measures recent structural flipping',()=>{
  assert.equal(transitionCount(['UP','UP','DOWN','UP','UP'],4),2);
  assert.equal(transitionCount(['UP','UP','UP','UP'],3),0);
  assert.equal(transitionCount(['UP','DOWN'],5),1);
});

test('relative spread percent is signed and normalized',()=>{
  assert.equal(relativeSpreadPct(105,100,100),5);
  assert.equal(relativeSpreadPct(95,100,100),-5);
  assert.throws(()=>relativeSpreadPct(1,1,0),/INVALID_REFERENCE/);
});
