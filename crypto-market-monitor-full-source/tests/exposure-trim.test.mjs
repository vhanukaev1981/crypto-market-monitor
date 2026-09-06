import test from 'node:test';
import assert from 'node:assert/strict';
import * as exposureTrim from '../algo/exposure-trim.mjs';

function nearlyEqual(actual, expected, tolerance=1e-9) {
  assert.ok(Math.abs(actual-expected)<=tolerance, `expected ${actual} ≈ ${expected}`);
}

test('partial hard-cap trim reduces a 31% position to 30% after execution friction and preserves accounting', () => {
  assert.equal(typeof exposureTrim.applyHardExposureTrim, 'function');

  const cash=69000;
  const referencePrice=100;
  const position={
    qty:310,
    totalCost:25000,
    entryTime:'2026-01-01T00:00:00.000Z',
    entryPrice:80,
    initialStop:70,
    trailingStop:90,
    entryScore:88,
  };

  const result=exposureTrim.applyHardExposureTrim({
    time:'2026-01-02T00:00:00.000Z',
    cash,
    position,
    referencePrice,
    entryAllocationCapPct:25,
    hardExposureCapPct:30,
    spreadBps:2,
    slippageBps:2,
    feeBps:10,
  });

  assert.equal(result.action,'REDUCE');
  assert.equal(result.event.reasonCode,'RISK_HARD_EXPOSURE_CAP');
  assert.ok(result.event.exposurePctBefore>30);
  assert.ok(result.postExposurePct<=30.000000001, `post exposure ${result.postExposurePct}%`);
  assert.ok(result.position.qty<position.qty);
  assert.ok(result.position.totalCost<position.totalCost);
  assert.ok(result.cash>cash);
  assert.equal(result.trade.exitReason,'HARD_EXPOSURE_TRIM');
  assert.ok(result.trade.qty>0);
  assert.ok(result.executionCost>0);

  const soldFraction=result.trade.qty/position.qty;
  nearlyEqual(result.position.totalCost, position.totalCost*(1-soldFraction), 1e-7);
  nearlyEqual(result.trade.pnl, result.fill.cashDelta-position.totalCost*soldFraction, 1e-7);
  nearlyEqual(result.cash, cash+result.fill.cashDelta, 1e-7);
  nearlyEqual(result.cash+result.position.qty*referencePrice, result.postEquity, 1e-7);
});

test('hard-cap trim is a no-op when drift stays below the emergency cap', () => {
  assert.equal(typeof exposureTrim.applyHardExposureTrim, 'function');
  const position={qty:27,totalCost:2500,entryTime:'2026-01-01T00:00:00.000Z',entryPrice:92,initialStop:80,trailingStop:90,entryScore:80};
  const result=exposureTrim.applyHardExposureTrim({
    time:'2026-01-02T00:00:00.000Z',
    cash:73,
    position,
    referencePrice:1,
    entryAllocationCapPct:25,
    hardExposureCapPct:30,
    spreadBps:2,
    slippageBps:2,
    feeBps:10,
  });
  assert.equal(result.action,'HOLD');
  assert.equal(result.trade,null);
  assert.equal(result.fill,null);
  assert.equal(result.position.qty,position.qty);
  assert.equal(result.position.totalCost,position.totalCost);
});
