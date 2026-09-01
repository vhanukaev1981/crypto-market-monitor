import { validateBuildState, selectNextTask } from './autonomous-build-state.mjs';

const clone = (value) => structuredClone(value);

function emptyPlan(status, reasonCode) {
  return {
    status,
    task: null,
    requestedAction: null,
    reasonCode,
    evidenceRequirements: [],
  };
}

function validateRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new Error('AUTONOMOUS_BUILD_INVALID_REPOSITORY');
  for (const field of ['fullName', 'branch', 'headSha']) {
    if (typeof repository[field] !== 'string' || !repository[field]) {
      throw new Error('AUTONOMOUS_BUILD_INVALID_REPOSITORY');
    }
  }
}

function eligibleState(state) {
  const done = new Set(state.tasks.filter((task) => task.status === 'DONE').map((task) => task.id));
  return {
    ...state,
    lease: null,
    tasks: state.tasks.map((task) => (
      task.status === 'READY' && task.dependsOn.every((dependency) => done.has(dependency))
        ? task
        : task.status === 'READY' ? { ...task, status: 'BLOCKED' } : task
    )),
  };
}

function selectQualificationRepair(state) {
  return state.tasks
    .filter((task) => (
      task.status === 'READY' &&
      task.priority === 'REGRESSION' &&
      ['DEBUG', 'CI', 'TEST'].includes(task.actionClass)
    ))
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

export function planAutonomousBuildCycle(input, { nowMs = 0 } = {}) {
  validateBuildState(input?.state);
  validateRepository(input?.repository);
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('AUTONOMOUS_BUILD_INVALID_TIME');

  const state = clone(input.state);
  if (state.lease) {
    const validLease =
      typeof state.lease.taskId === 'string' &&
      typeof state.lease.owner === 'string' &&
      Number.isFinite(state.lease.expiresAtMs);
    if (!validLease) throw new Error('AUTONOMOUS_BUILD_INVALID_STATE');
    if (state.lease.expiresAtMs > nowMs) return emptyPlan('WAIT', 'ACTIVE_LEASE');
    return emptyPlan('BLOCKED', 'EXPIRED_LEASE_REQUIRES_RECOVERY');
  }

  if (state.tasks.every((task) => task.status === 'DONE')) {
    return emptyPlan('COMPLETE', 'ALL_TASKS_DONE');
  }

  const eligible = eligibleState(state);
  const qualificationFailed = input?.qualification?.status === 'FAIL';
  const selected = qualificationFailed
    ? selectQualificationRepair(eligible) ?? selectNextTask(eligible)
    : selectNextTask(eligible);

  if (!selected) return emptyPlan('BLOCKED', 'NO_ELIGIBLE_TASK');

  return {
    status: 'WORK',
    task: clone(selected),
    requestedAction: selected.actionClass,
    reasonCode: qualificationFailed ? 'QUALIFICATION_FAILED' : 'NEXT_ELIGIBLE_TASK',
    evidenceRequirements: ['START_SHA', 'RESULT_SHA', 'TEST_RESULT', 'WORKFLOW_RUN'],
  };
}
