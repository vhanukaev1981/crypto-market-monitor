const STATUSES = new Set(['READY', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
const PRIORITIES = ['SAFETY', 'REGRESSION', 'DATA_QUALITY', 'RECONCILIATION', 'PAPER_READINESS', 'RESEARCH_INFRA', 'OBSERVABILITY', 'REFACTOR'];
const ALLOWED_ACTION_CLASSES = new Set(['TEST', 'IMPLEMENT', 'DEBUG', 'CI', 'BACKTEST_INFRA', 'PAPER_INFRA', 'DOCS', 'OBSERVABILITY']);

function invalidState() {
  throw new Error('AUTONOMOUS_BUILD_INVALID_STATE');
}

function validateTask(task) {
  if (!task || typeof task !== 'object') invalidState();
  if (typeof task.id !== 'string' || !task.id.trim()) invalidState();
  if (!PRIORITIES.includes(task.priority)) invalidState();
  if (!STATUSES.has(task.status)) invalidState();
  if (!ALLOWED_ACTION_CLASSES.has(task.actionClass)) invalidState();
  if (!Number.isInteger(task.retryCount) || task.retryCount < 0) invalidState();
  if (!Number.isInteger(task.maxRetries) || task.maxRetries < 0) invalidState();
  if (!Array.isArray(task.dependsOn) || task.dependsOn.some((id) => typeof id !== 'string' || !id)) invalidState();
  if (!(task.blocker === null || typeof task.blocker === 'string')) invalidState();
  if (!Array.isArray(task.evidence)) invalidState();
}

export function validateBuildState(state) {
  if (!state || typeof state !== 'object' || state.version !== 1 || !Array.isArray(state.tasks)) invalidState();
  if (!(state.lease === null || typeof state.lease === 'object')) invalidState();
  if (!(state.lastCycle === null || typeof state.lastCycle === 'object')) invalidState();
  const ids = new Set();
  for (const task of state.tasks) {
    validateTask(task);
    if (ids.has(task.id)) invalidState();
    ids.add(task.id);
  }
  return true;
}

export function selectNextTask(state) {
  validateBuildState(state);
  const rank = new Map(PRIORITIES.map((priority, index) => [priority, index]));
  const ready = state.tasks.filter((task) => task.status === 'READY');
  ready.sort((a, b) => rank.get(a.priority) - rank.get(b.priority) || a.id.localeCompare(b.id));
  return ready[0] ?? null;
}

export function transitionTask(state, taskId, nextStatus, evidence) {
  validateBuildState(state);
  if (!STATUSES.has(nextStatus)) throw new Error('AUTONOMOUS_BUILD_INVALID_TRANSITION');
  const index = state.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw new Error('AUTONOMOUS_BUILD_INVALID_TRANSITION');
  const current = state.tasks[index];
  const allowed =
    (current.status === 'READY' && nextStatus === 'IN_PROGRESS') ||
    (current.status === 'IN_PROGRESS' && ['DONE', 'BLOCKED', 'READY'].includes(nextStatus)) ||
    (current.status === 'BLOCKED' && nextStatus === 'READY' && current.retryCount < current.maxRetries);
  if (!allowed) throw new Error('AUTONOMOUS_BUILD_INVALID_TRANSITION');
  const tasks = state.tasks.map((task, taskIndex) => taskIndex === index ? {
    ...task,
    status: nextStatus,
    evidence: evidence === undefined ? task.evidence : evidence,
  } : { ...task });
  const next = { ...state, tasks };
  validateBuildState(next);
  return next;
}

export const AUTONOMOUS_BUILD_PRIORITIES = Object.freeze([...PRIORITIES]);
export const AUTONOMOUS_BUILD_ACTION_CLASSES = Object.freeze([...ALLOWED_ACTION_CLASSES]);
