// Single-active orchestrator lease / fencing for the ALGOBOT autonomous
// orchestrator (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Only one orchestrator instance may mutate the repository / task state machine
// at a time. The canonical lease record lives in an injected durable `store`
// (a GitHub-visible file in production); a host-local lock is only an
// optimisation and is out of scope here.
//
// The lease carries a MONOTONIC fence token. A takeover (of an expired or
// released lease) increments it; a renew keeps it. Every mutating cycle must
// present the current token through assertLease() / guardMutation(); a stale
// instance can neither renew, assert, release, nor run a guarded mutation.

const ERR = Object.freeze({
  INPUT: 'ORCHESTRATOR_LEASE_INVALID_INPUT',
  HELD: 'ORCHESTRATOR_LEASE_HELD',
  LOST: 'ORCHESTRATOR_LEASE_LOST',
  STALE_FENCE: 'ORCHESTRATOR_STALE_FENCE',
  EXPIRED: 'ORCHESTRATOR_LEASE_EXPIRED',
  NOT_HELD: 'ORCHESTRATOR_LEASE_NOT_HELD',
  CONFLICT: 'ORCHESTRATOR_LEASE_CONFLICT',
});

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function summarize(record) {
  return Object.freeze({
    fenceToken: record.fenceToken,
    holderId: record.holderId,
    state: record.state,
    acquiredAtMs: record.acquiredAtMs,
    renewedAtMs: record.renewedAtMs,
    expiresAtMs: record.expiresAtMs,
  });
}

export function createOrchestratorLease(config = {}) {
  const { store, holderId, ttlMs, now } = config;

  if (!store || typeof store !== 'object'
    || typeof store.readLease !== 'function' || typeof store.writeLease !== 'function') {
    fail(ERR.INPUT, 'store must provide readLease() and writeLease()');
  }
  if (!isNonEmptyString(holderId)) fail(ERR.INPUT, 'holderId is required');
  if (!isPositiveInt(ttlMs)) fail(ERR.INPUT, 'ttlMs must be a positive integer');
  if (typeof now !== 'function') fail(ERR.INPUT, 'now must be a function');

  function isExpired(record, t) {
    return record.state === 'HELD' && t >= record.expiresAtMs;
  }

  function isConflict(error) {
    return !!error && typeof error.message === 'string' && error.message.includes(ERR.CONFLICT);
  }

  async function casWrite(next, expectedFenceToken, onConflict) {
    try {
      return await store.writeLease(next, expectedFenceToken);
    } catch (error) {
      if (isConflict(error)) return onConflict(error);
      throw error;
    }
  }

  function heldRecord(fenceToken, t) {
    return { state: 'HELD', holderId, fenceToken, acquiredAtMs: t, renewedAtMs: t, expiresAtMs: t + ttlMs };
  }

  async function renewFrom(current, t) {
    const next = { ...current, state: 'HELD', holderId, renewedAtMs: t, expiresAtMs: t + ttlMs };
    await store.writeLease(next, current.fenceToken);
    return summarize(next);
  }

  async function acquireLease() {
    const t = now();
    const current = await store.readLease();

    if (!current) {
      const next = heldRecord(1, t);
      return casWrite(next, null, async () => {
        const raced = await store.readLease();
        if (raced && raced.state === 'HELD' && !isExpired(raced, t) && raced.holderId !== holderId) {
          fail(ERR.HELD, `held by ${raced.holderId} until ${raced.expiresAtMs}`);
        }
        fail(ERR.CONFLICT, 'lost acquisition race');
        return undefined;
      }).then(() => summarize(next));
    }

    if (current.state === 'HELD' && !isExpired(current, t)) {
      if (current.holderId === holderId) return renewFrom(current, t);
      fail(ERR.HELD, `held by ${current.holderId} until ${current.expiresAtMs}`);
    }

    // Expired HELD lease or a RELEASED tombstone: take over, bump the token.
    const next = heldRecord(current.fenceToken + 1, t);
    return casWrite(next, current.fenceToken, async () => {
      const raced = await store.readLease();
      if (raced && raced.state === 'HELD' && !isExpired(raced, t) && raced.holderId !== holderId) {
        fail(ERR.HELD, `held by ${raced.holderId} until ${raced.expiresAtMs}`);
      }
      fail(ERR.CONFLICT, 'lost takeover race');
      return undefined;
    }).then(() => summarize(next));
  }

  async function renewLease(fenceToken) {
    if (!isPositiveInt(fenceToken)) fail(ERR.INPUT, 'fenceToken must be a positive integer');
    const t = now();
    const current = await store.readLease();
    if (!current || current.state !== 'HELD' || current.holderId !== holderId) {
      fail(ERR.LOST, 'lease is no longer held by this instance');
    }
    if (current.fenceToken !== fenceToken) {
      fail(ERR.STALE_FENCE, `expected token ${current.fenceToken}, got ${fenceToken}`);
    }
    if (isExpired(current, t)) fail(ERR.EXPIRED, 'lease has expired; re-acquire instead');
    return renewFrom(current, t);
  }

  async function assertLease(fenceToken) {
    if (!isPositiveInt(fenceToken)) fail(ERR.INPUT, 'fenceToken must be a positive integer');
    const t = now();
    const current = await store.readLease();
    if (!current || current.state !== 'HELD' || current.holderId !== holderId) {
      fail(ERR.LOST, 'lease is not held by this instance');
    }
    if (current.fenceToken !== fenceToken) {
      fail(ERR.STALE_FENCE, `expected token ${current.fenceToken}, got ${fenceToken}`);
    }
    if (isExpired(current, t)) fail(ERR.EXPIRED, 'lease has expired');
    return true;
  }

  async function adoptLease() {
    const t = now();
    const current = await store.readLease();
    if (!current || current.state !== 'HELD' || current.holderId !== holderId || isExpired(current, t)) {
      fail(ERR.NOT_HELD, 'no live lease held by this instance to adopt');
    }
    return summarize(current);
  }

  async function releaseLease(fenceToken) {
    if (!isPositiveInt(fenceToken)) fail(ERR.INPUT, 'fenceToken must be a positive integer');
    const current = await store.readLease();
    if (!current || current.state === 'RELEASED') return Object.freeze({ released: true });
    if (current.holderId !== holderId) {
      fail(ERR.LOST, `lease is held by ${current.holderId}, not ${holderId}`);
    }
    if (current.fenceToken !== fenceToken) {
      fail(ERR.STALE_FENCE, `expected token ${current.fenceToken}, got ${fenceToken}`);
    }
    const tombstone = { ...current, state: 'RELEASED', holderId: null, releasedAtMs: now() };
    await store.writeLease(tombstone, current.fenceToken);
    return Object.freeze({ released: true });
  }

  async function guardMutation(fenceToken, mutation) {
    if (typeof mutation !== 'function') fail(ERR.INPUT, 'mutation must be a function');
    await assertLease(fenceToken);
    return mutation();
  }

  return Object.freeze({
    holderId,
    ttlMs,
    acquireLease,
    renewLease,
    assertLease,
    adoptLease,
    releaseLease,
    guardMutation,
  });
}
