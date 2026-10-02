import { validateBuildState, selectNextTask, transitionTask } from './autonomous-build-state.mjs';

const clone = (value) => structuredClone(value);
const fail = (code) => { throw new Error(code); };

function validateLease(lease) {
  if (lease === null) return;
  if (!lease || typeof lease !== 'object') fail('AUTONOMOUS_BUILD_INVALID_STATE');
  if (typeof lease.taskId !== 'string' || !lease.taskId) fail('AUTONOMOUS_BUILD_INVALID_STATE');
  if (typeof lease.owner !== 'string' || !lease.owner) fail('AUTONOMOUS_BUILD_INVALID_STATE');
  if (!Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs < 0) fail('AUTONOMOUS_BUILD_INVALID_STATE');
}

function validateQueue(queue) {
  validateBuildState(queue);
  validateLease(queue.lease);
  const ids = new Set(queue.tasks.map((task) => task.id));
  for (const task of queue.tasks) {
    if (task.dependsOn.some((id) => id === task.id || !ids.has(id))) fail('AUTONOMOUS_BUILD_INVALID_STATE');
  }
  if (queue.lease) {
    const leased = queue.tasks.find((task) => task.id === queue.lease.taskId);
    if (!leased || leased.status !== 'IN_PROGRESS') fail('AUTONOMOUS_BUILD_INVALID_STATE');
  }
  return true;
}

function sameTask(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function eligibleState(queue) {
  const done = new Set(queue.tasks.filter((task) => task.status === 'DONE').map((task) => task.id));
  return {
    ...queue,
    lease: null,
    tasks: queue.tasks.map((task) => task.status === 'READY' && task.dependsOn.every((id) => done.has(id))
      ? task
      : task.status === 'READY' ? { ...task, status: 'BLOCKED', blocker: 'DEPENDENCY_NOT_DONE' } : task),
  };
}

function assertOwner(queue, owner) {
  validateQueue(queue);
  if (!queue.lease) fail('AUTONOMOUS_BUILD_LEASE_REQUIRED');
  if (queue.lease.owner !== owner) fail('AUTONOMOUS_BUILD_LEASE_OWNER_MISMATCH');
}

export function createBuildQueue(tasks = []) {
  const queue = { version: 1, lease: null, tasks: clone(tasks), lastCycle: null };
  validateQueue(queue);
  return queue;
}

export function enqueueTask(queue, task) {
  validateQueue(queue);
  const existing = queue.tasks.find((item) => item.id === task?.id);
  if (existing) {
    if (sameTask(existing, task)) return clone(queue);
    fail('AUTONOMOUS_BUILD_TASK_CONFLICT');
  }
  const next = { ...clone(queue), tasks: [...clone(queue.tasks), clone(task)] };
  validateQueue(next);
  return next;
}

export function claimNextTask(queue, { owner, nowMs, leaseMs }) {
  validateQueue(queue);
  if (typeof owner !== 'string' || !owner || !Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    fail('AUTONOMOUS_BUILD_INVALID_CLAIM');
  }
  let next = clone(queue);
  if (next.lease && next.lease.expiresAtMs > nowMs) fail('AUTONOMOUS_BUILD_LEASE_ACTIVE');
  if (next.lease) {
    const index = next.tasks.findIndex((task) => task.id === next.lease.taskId);
    const abandoned = next.tasks[index];
    next.tasks[index] = {
      ...abandoned,
      status: 'BLOCKED',
      retryCount: abandoned.retryCount + 1,
      blocker: 'LEASE_EXPIRED',
    };
    next.lease = null;
  }
  const selectable = eligibleState(next);
  const selected = selectNextTask(selectable);
  if (!selected) return { ...next, lease: null };
  next = transitionTask(next, selected.id, 'IN_PROGRESS');
  next.tasks = next.tasks.map((task) => task.id === selected.id ? { ...task, blocker: null } : task);
  next.lease = { taskId: selected.id, owner, expiresAtMs: nowMs + leaseMs };
  validateQueue(next);
  return next;
}

export function completeClaim(queue, { owner, evidence }) {
  assertOwner(queue, owner);
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => typeof item !== 'string' || !item)) {
    fail('AUTONOMOUS_BUILD_EVIDENCE_REQUIRED');
  }
  let next = transitionTask(queue, queue.lease.taskId, 'DONE', clone(evidence));
  next.lease = null;
  next.lastCycle = { taskId: queue.lease.taskId, outcome: 'DONE', evidence: clone(evidence) };
  validateQueue(next);
  return next;
}

export function blockClaim(queue, { owner, blocker }) {
  assertOwner(queue, owner);
  if (typeof blocker !== 'string' || !blocker) fail('AUTONOMOUS_BUILD_BLOCKER_REQUIRED');
  let next = transitionTask(queue, queue.lease.taskId, 'BLOCKED');
  next.tasks = next.tasks.map((task) => task.id === queue.lease.taskId ? {
    ...task,
    retryCount: task.retryCount + 1,
    blocker,
  } : task);
  next.lease = null;
  next.lastCycle = { taskId: queue.lease.taskId, outcome: 'BLOCKED', blocker };
  validateQueue(next);
  return next;
}
