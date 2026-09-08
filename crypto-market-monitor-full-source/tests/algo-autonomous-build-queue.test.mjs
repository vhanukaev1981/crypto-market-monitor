import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBuildQueue,
  enqueueTask,
  claimNextTask,
  completeClaim,
  blockClaim,
} from '../algo/autonomous-build-queue.mjs';

const task = (overrides = {}) => ({
  id: 'task-a',
  priority: 'SAFETY',
  status: 'READY',
  actionClass: 'TEST',
  retryCount: 0,
  maxRetries: 2,
  dependsOn: [],
  blocker: null,
  evidence: [],
  ...overrides,
});

test('creates a versioned durable queue with no active lease', () => {
  const queue = createBuildQueue([task()]);
  assert.equal(queue.version, 1);
  assert.equal(queue.lease, null);
  assert.equal(queue.tasks.length, 1);
});

test('enqueue is idempotent for identical task and fails closed on conflicting duplicate id', () => {
  const queue = createBuildQueue([task()]);
  assert.deepEqual(enqueueTask(queue, task()), queue);
  assert.throws(() => enqueueTask(queue, task({ priority: 'REGRESSION' })), /AUTONOMOUS_BUILD_TASK_CONFLICT/);
});

test('claim selects the next eligible task and creates an expiring lease', () => {
  const queue = createBuildQueue([
    task({ id: 'blocked-by-dep', dependsOn: ['dep'] }),
    task({ id: 'dep', priority: 'REGRESSION' }),
    task({ id: 'safety' }),
  ]);
  const claimed = claimNextTask(queue, { owner: 'cycle-1', nowMs: 1000, leaseMs: 5000 });
  assert.equal(claimed.lease.taskId, 'safety');
  assert.equal(claimed.lease.owner, 'cycle-1');
  assert.equal(claimed.lease.expiresAtMs, 6000);
  assert.equal(claimed.tasks.find((item) => item.id === 'safety').status, 'IN_PROGRESS');
});

test('active lease prevents a second concurrent claim', () => {
  const claimed = claimNextTask(createBuildQueue([task()]), { owner: 'cycle-1', nowMs: 1000, leaseMs: 5000 });
  assert.throws(() => claimNextTask(claimed, { owner: 'cycle-2', nowMs: 2000, leaseMs: 5000 }), /AUTONOMOUS_BUILD_LEASE_ACTIVE/);
});

test('expired lease is recovered fail closed by blocking the abandoned task before selecting another', () => {
  const claimed = claimNextTask(createBuildQueue([task(), task({ id: 'task-b', priority: 'REGRESSION' })]), { owner: 'cycle-1', nowMs: 1000, leaseMs: 1000 });
  const recovered = claimNextTask(claimed, { owner: 'cycle-2', nowMs: 3000, leaseMs: 1000 });
  const abandoned = recovered.tasks.find((item) => item.id === 'task-a');
  assert.equal(abandoned.status, 'BLOCKED');
  assert.equal(abandoned.blocker, 'LEASE_EXPIRED');
  assert.equal(abandoned.retryCount, 1);
  assert.equal(recovered.lease.taskId, 'task-b');
});

test('dependencies must be DONE before a task becomes claimable', () => {
  const queue = createBuildQueue([
    task({ id: 'parent', priority: 'REGRESSION' }),
    task({ id: 'child', dependsOn: ['parent'] }),
  ]);
  const first = claimNextTask(queue, { owner: 'c1', nowMs: 0, leaseMs: 1000 });
  assert.equal(first.lease.taskId, 'parent');
  const done = completeClaim(first, { owner: 'c1', evidence: ['ci:green'] });
  const second = claimNextTask(done, { owner: 'c2', nowMs: 2000, leaseMs: 1000 });
  assert.equal(second.lease.taskId, 'child');
});

test('only lease owner can complete or block a claimed task', () => {
  const claimed = claimNextTask(createBuildQueue([task()]), { owner: 'cycle-1', nowMs: 0, leaseMs: 1000 });
  assert.throws(() => completeClaim(claimed, { owner: 'other', evidence: [] }), /AUTONOMOUS_BUILD_LEASE_OWNER_MISMATCH/);
  assert.throws(() => blockClaim(claimed, { owner: 'other', blocker: 'CI_RED' }), /AUTONOMOUS_BUILD_LEASE_OWNER_MISMATCH/);
});

test('completion requires evidence and clears the lease', () => {
  const claimed = claimNextTask(createBuildQueue([task()]), { owner: 'cycle-1', nowMs: 0, leaseMs: 1000 });
  assert.throws(() => completeClaim(claimed, { owner: 'cycle-1', evidence: [] }), /AUTONOMOUS_BUILD_EVIDENCE_REQUIRED/);
  const done = completeClaim(claimed, { owner: 'cycle-1', evidence: ['run:123'] });
  assert.equal(done.lease, null);
  assert.equal(done.tasks[0].status, 'DONE');
  assert.deepEqual(done.tasks[0].evidence, ['run:123']);
});

test('blocking increments retry count, records blocker, and clears lease', () => {
  const claimed = claimNextTask(createBuildQueue([task()]), { owner: 'cycle-1', nowMs: 0, leaseMs: 1000 });
  const blocked = blockClaim(claimed, { owner: 'cycle-1', blocker: 'CI_RED' });
  assert.equal(blocked.lease, null);
  assert.equal(blocked.tasks[0].status, 'BLOCKED');
  assert.equal(blocked.tasks[0].retryCount, 1);
  assert.equal(blocked.tasks[0].blocker, 'CI_RED');
});
