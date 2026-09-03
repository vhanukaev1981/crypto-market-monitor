import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLiveCanaryOrder } from '../algo/live-canary-policy.mjs';

const valid = (overrides = {}) => ({
  enabled: true,
  qualification: { status: 'PASS', fresh: true },
  marketType: 'SPOT',
  leverage: 1,
  requestedNotionalUsd: 10,
  committedNotionalUsd: 0,
  ...overrides,
});

test('live canary is disabled by default', () => {
  const result = evaluateLiveCanaryOrder(valid({ enabled: false }));
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'LIVE_CANARY_DISABLED');
});

test('requires fresh PASS qualification', () => {
  for (const qualification of [undefined, { status: 'MISSING', fresh: true }, { status: 'PASS', fresh: false }]) {
    const result = evaluateLiveCanaryOrder(valid({ qualification }));
    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'QUALIFICATION_REQUIRED');
  }
});

test('allows Spot only with no leverage', () => {
  for (const overrides of [
    { marketType: 'FUTURES' },
    { marketType: 'MARGIN' },
    { leverage: 2 },
  ]) {
    const result = evaluateLiveCanaryOrder(valid(overrides));
    assert.equal(result.allowed, false);
  }
});

test('never permits aggregate committed capital above USD 100', () => {
  assert.deepEqual(evaluateLiveCanaryOrder(valid({ committedNotionalUsd: 90, requestedNotionalUsd: 10 })), {
    allowed: true,
    reasonCode: 'ALLOW',
    approvedNotionalUsd: 10,
  });

  const blocked = evaluateLiveCanaryOrder(valid({ committedNotionalUsd: 90, requestedNotionalUsd: 10.01 }));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reasonCode, 'LIVE_CANARY_BUDGET_EXCEEDED');
  assert.equal(blocked.approvedNotionalUsd, 0);
});

test('rejects malformed monetary inputs fail closed', () => {
  for (const requestedNotionalUsd of [0, -1, NaN, Infinity, '10']) {
    const result = evaluateLiveCanaryOrder(valid({ requestedNotionalUsd }));
    assert.equal(result.allowed, false);
    assert.equal(result.approvedNotionalUsd, 0);
  }
});
