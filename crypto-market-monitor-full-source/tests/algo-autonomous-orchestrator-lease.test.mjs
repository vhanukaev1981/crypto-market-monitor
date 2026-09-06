import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrchestratorLease } from '../algo/autonomous-orchestrator-lease.mjs';

// ---------------------------------------------------------------------------
// Task 3 — Single-active orchestrator lease / fencing (RED).
//
// Only one orchestrator instance may mutate the repository/task state machine.
// The canonical lease record lives in an injected durable `store` (GitHub in
// production); a host-local lock is only an optimisation. Every mutating cycle
// must present a CURRENT fence token via assertLease(); a stale instance can
// neither renew, assert, nor act.
// ---------------------------------------------------------------------------

// In-memory durable store with compare-and-set on the fence token, modelling a
// GitHub file update guarded by its blob SHA.
function fakeLeaseStore() {
  let record = null;
  return {
    _peek: () => (record ? { ...record } : null),
    async readLease() {
      return record ? { ...record } : null;
    },
    async writeLease(next, expectedFenceToken) {
      const current = record ? record.fenceToken : null;
      if (current !== (expectedFenceToken ?? null)) {
        throw new Error('ORCHESTRATOR_LEASE_CONFLICT: compare-and-set failed');
      }
      record = next === null ? null : { ...next };
      return record ? { ...record } : null;
    },
  };
}

function clockFrom(startMs) {
  let ms = startMs;
  const now = () => ms;
  now.advance = (delta) => { ms += delta; };
  now.set = (value) => { ms = value; };
  return now;
}

const TTL = 60_000;

function makeLease(store, holderId, now, overrides = {}) {
  return createOrchestratorLease({ store, holderId, ttlMs: TTL, now, ...overrides });
}

test('a fresh store lets the first orchestrator acquire fence token 1', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const held = await a.acquireLease();
  assert.equal(held.fenceToken, 1);
  assert.equal(held.expiresAtMs, 1_000 + TTL);
  assert.equal(store._peek().holderId, 'orch-a');
});

test('a second orchestrator cannot acquire while the lease is live', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  await makeLease(store, 'orch-a', now).acquireLease();
  const b = makeLease(store, 'orch-b', now);
  await assert.rejects(() => b.acquireLease(), /ORCHESTRATOR_LEASE_HELD/);
});

test('two orchestrators racing from empty: exactly one wins, the other is rejected', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const b = makeLease(store, 'orch-b', now);
  const results = await Promise.allSettled([a.acquireLease(), b.acquireLease()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, JSON.stringify(results));
  assert.equal(bad.length, 1, JSON.stringify(results));
  assert.match(bad[0].reason.message, /ORCHESTRATOR_LEASE_HELD|ORCHESTRATOR_LEASE_CONFLICT/);
});

test('renewLease keeps the same fence token and extends the expiry', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const { fenceToken } = await a.acquireLease();
  now.advance(30_000);
  const renewed = await a.renewLease(fenceToken);
  assert.equal(renewed.fenceToken, fenceToken);
  assert.equal(renewed.expiresAtMs, 31_000 + TTL);
});

test('assertLease passes for the current holder and current token', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const { fenceToken } = await a.acquireLease();
  assert.equal(await a.assertLease(fenceToken), true);
});

test('expired lease can be taken over — fence token increments', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  await a.acquireLease(); // token 1, expires 61_000
  now.set(61_001); // lease has expired
  const b = makeLease(store, 'orch-b', now);
  const taken = await b.acquireLease();
  assert.equal(taken.fenceToken, 2);
  assert.equal(store._peek().holderId, 'orch-b');
});

test('after takeover the previous holder is fully fenced out', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const { fenceToken: staleToken } = await a.acquireLease();
  now.set(61_001);
  await makeLease(store, 'orch-b', now).acquireLease(); // token 2

  await assert.rejects(() => a.assertLease(staleToken), /ORCHESTRATOR_STALE_FENCE|ORCHESTRATOR_LEASE_LOST/);
  await assert.rejects(() => a.renewLease(staleToken), /ORCHESTRATOR_STALE_FENCE|ORCHESTRATOR_LEASE_LOST/);
});

test('assertLease rejects a stale fence token even before expiry (holder changed)', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  await makeLease(store, 'orch-a', now).acquireLease();
  now.set(61_001);
  const b = makeLease(store, 'orch-b', now);
  await b.acquireLease();
  now.set(61_500); // b's lease still live
  const a2 = makeLease(store, 'orch-a', now);
  await assert.rejects(() => a2.assertLease(1), /ORCHESTRATOR_STALE_FENCE|ORCHESTRATOR_LEASE_LOST/);
});

test('assertLease rejects once the holder\'s own lease has expired', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const { fenceToken } = await a.acquireLease();
  now.set(61_001);
  await assert.rejects(() => a.assertLease(fenceToken), /ORCHESTRATOR_LEASE_EXPIRED|ORCHESTRATOR_LEASE_LOST/);
});

test('crash/restart: a new process for the same holder can adopt a still-valid lease', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const { fenceToken } = await makeLease(store, 'orch-a', now).acquireLease();
  now.advance(10_000);
  const restarted = makeLease(store, 'orch-a', now);
  const adopted = await restarted.adoptLease();
  assert.equal(adopted.fenceToken, fenceToken);
  assert.equal(await restarted.assertLease(fenceToken), true);
});

test('crash/restart after expiry: the lease cannot be adopted, only re-acquired with a new token', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  await makeLease(store, 'orch-a', now).acquireLease();
  now.set(61_001);
  const restarted = makeLease(store, 'orch-a', now);
  await assert.rejects(() => restarted.adoptLease(), /ORCHESTRATOR_LEASE_NOT_HELD|ORCHESTRATOR_LEASE_EXPIRED/);
  const reacquired = await restarted.acquireLease();
  assert.equal(reacquired.fenceToken, 2);
});

test('releaseLease frees the lease for another orchestrator immediately', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const { fenceToken } = await a.acquireLease();
  await a.releaseLease(fenceToken);
  const b = makeLease(store, 'orch-b', now);
  const held = await b.acquireLease();
  assert.equal(held.fenceToken, 2);
});

test('releaseLease with a stale token does not free someone else\'s lease', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  await makeLease(store, 'orch-a', now).acquireLease();
  now.set(61_001);
  await makeLease(store, 'orch-b', now).acquireLease(); // token 2, holder b
  const a = makeLease(store, 'orch-a', now);
  await assert.rejects(() => a.releaseLease(1), /ORCHESTRATOR_STALE_FENCE|ORCHESTRATOR_LEASE_LOST/);
  assert.equal(store._peek().holderId, 'orch-b');
});

test('guardMutation runs the callback only while the fence token is current', async () => {
  const store = fakeLeaseStore();
  const now = clockFrom(1_000);
  const a = makeLease(store, 'orch-a', now);
  const { fenceToken } = await a.acquireLease();
  let ran = 0;
  const out = await a.guardMutation(fenceToken, async () => { ran += 1; return 'did-work'; });
  assert.equal(ran, 1);
  assert.equal(out, 'did-work');

  now.set(61_001);
  await makeLease(store, 'orch-b', now).acquireLease();
  await assert.rejects(
    () => a.guardMutation(fenceToken, async () => { ran += 1; }),
    /ORCHESTRATOR_STALE_FENCE|ORCHESTRATOR_LEASE_LOST|ORCHESTRATOR_LEASE_EXPIRED/,
  );
  assert.equal(ran, 1, 'stale instance must not run its mutation');
});

test('rejects malformed configuration (fail closed)', () => {
  assert.throws(() => createOrchestratorLease({ store: fakeLeaseStore(), holderId: '', ttlMs: TTL, now: clockFrom(0) }), /ORCHESTRATOR_LEASE_INVALID_INPUT/);
  assert.throws(() => createOrchestratorLease({ store: fakeLeaseStore(), holderId: 'x', ttlMs: 0, now: clockFrom(0) }), /ORCHESTRATOR_LEASE_INVALID_INPUT/);
  assert.throws(() => createOrchestratorLease({ store: {}, holderId: 'x', ttlMs: TTL, now: clockFrom(0) }), /ORCHESTRATOR_LEASE_INVALID_INPUT/);
});
