import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeDispatcher } from '../algo/autonomous-claude-dispatch.mjs';

// ---------------------------------------------------------------------------
// Task 4 — Claude non-interactive dispatch adapter (RED).
//
// createClaudeDispatcher({ runProcess, ... }).dispatchClaudeTask({
//   task, baseSha, branch, acceptanceCriteria, constraints, attempt })
//
// Builds an exact-SHA-bound task packet, invokes Claude non-interactively
// through an INJECTED process runner (no live Claude session in tests), and
// accepts ONLY machine-readable completion markers. Prose is never a success.
// ---------------------------------------------------------------------------

const BASE_SHA = 'a1'.repeat(20);
const HEAD_SHA = 'b2'.repeat(20);
const BRANCH = 'agent/claude-p0-task3';

const MANDATORY_CONSTRAINTS = [
  'NO_MERGE_TO_MAIN',
  'NO_REAL_BYBIT_ORDER',
  'PRESERVE_CANARY_LIMITS',
  'STRICT_RED_GREEN_TDD',
];

function makeRunner(result) {
  const calls = [];
  const runProcess = async (spec) => {
    calls.push(spec);
    if (typeof result === 'function') return result(spec);
    return result;
  };
  runProcess.calls = calls;
  return runProcess;
}

function dispatcherWith(result, config = {}) {
  return createClaudeDispatcher({ runProcess: makeRunner(result), branchPrefix: 'agent/claude-', ...config });
}

function baseArgs(overrides = {}) {
  return {
    task: { id: 'p0-task-3-executor-fencing', repository: 'vhanukaev1981/crypto-market-monitor' },
    baseSha: BASE_SHA,
    branch: BRANCH,
    acceptanceCriteria: 'Implement executor fencing with RED then GREEN tests.',
    constraints: [...MANDATORY_CONSTRAINTS],
    attempt: 1,
    ...overrides,
  };
}

const OK_LINE = (extra = {}) => `chatter\nALGOBOT_COMPLETION_JSON: ${JSON.stringify({ completion: 'READY_FOR_CI', headSha: HEAD_SHA, pr: 42, ...extra })}\nmore chatter`;

test('accepts a machine-readable READY_FOR_CI completion and returns structured data', async () => {
  const runner = makeRunner({ code: 0, stdout: OK_LINE(), stderr: '' });
  const dispatcher = createClaudeDispatcher({ runProcess: runner, branchPrefix: 'agent/claude-' });
  const out = await dispatcher.dispatchClaudeTask(baseArgs());
  assert.equal(out.completion, 'READY_FOR_CI');
  assert.equal(out.headSha, HEAD_SHA);
  assert.equal(out.prNumber, 42);
  assert.equal(out.branch, BRANCH);
  assert.equal(out.baseSha, BASE_SHA);
  assert.equal(out.attempt, 1);
});

test('prose-only "success" with no completion marker is rejected (fail closed)', async () => {
  const dispatcher = dispatcherWith({ code: 0, stdout: 'All done! Everything passes and looks great. Shipping it.', stderr: '' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs()),
    /ORCHESTRATOR_DISPATCH_UNPARSEABLE_COMPLETION/,
  );
});

test('an unknown completion verdict is rejected', async () => {
  const dispatcher = dispatcherWith({ code: 0, stdout: 'ALGOBOT_COMPLETION_JSON: {"completion":"LGTM"}', stderr: '' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs()),
    /ORCHESTRATOR_DISPATCH_UNPARSEABLE_COMPLETION/,
  );
});

test('BLOCKED is a valid machine outcome, not an error', async () => {
  const dispatcher = dispatcherWith({ code: 0, stdout: 'ALGOBOT_COMPLETION_JSON: {"completion":"BLOCKED","reason":"missing CI secret"}', stderr: '' });
  const out = await dispatcher.dispatchClaudeTask(baseArgs());
  assert.equal(out.completion, 'BLOCKED');
  assert.match(out.reason, /missing CI secret/);
});

test('READY_FOR_CHATGPT_REVIEW and CHANGES_APPLIED are accepted verdicts', async () => {
  for (const completion of ['READY_FOR_CHATGPT_REVIEW', 'CHANGES_APPLIED']) {
    const dispatcher = dispatcherWith({ code: 0, stdout: `ALGOBOT_COMPLETION_JSON: ${JSON.stringify({ completion, headSha: HEAD_SHA })}`, stderr: '' });
    const out = await dispatcher.dispatchClaudeTask(baseArgs());
    assert.equal(out.completion, completion);
  }
});

test('the task packet carries the exact base SHA, branch, TDD rule and safety constraints', async () => {
  const runner = makeRunner({ code: 0, stdout: OK_LINE(), stderr: '' });
  const dispatcher = createClaudeDispatcher({ runProcess: runner, branchPrefix: 'agent/claude-' });
  await dispatcher.dispatchClaudeTask(baseArgs());
  const spec = runner.calls[0];
  const packet = spec.input;
  assert.match(packet, new RegExp(BASE_SHA));
  assert.match(packet, new RegExp(BRANCH));
  assert.match(packet, /RED/);
  assert.match(packet, /GREEN/);
  assert.match(packet, /NO_MERGE_TO_MAIN/);
  assert.match(packet, /NO_REAL_BYBIT_ORDER/);
  // a machine-readable stop marker Claude must emit
  assert.match(packet, /ALGOBOT_COMPLETION_JSON/);
});

test('retry attempt metadata and prior findings are included in the packet', async () => {
  const runner = makeRunner({ code: 0, stdout: OK_LINE(), stderr: '' });
  const dispatcher = createClaudeDispatcher({ runProcess: runner, branchPrefix: 'agent/claude-' });
  await dispatcher.dispatchClaudeTask(baseArgs({ attempt: 3, priorFindings: ['CI failed: race in lease test', 'flaky timeout'] }));
  const packet = runner.calls[0].input;
  assert.match(packet, /attempt[^0-9]*3/i);
  assert.match(packet, /race in lease test/);
});

test('HARD refuses to target `main` and never spawns a process', async () => {
  const runner = makeRunner({ code: 0, stdout: OK_LINE(), stderr: '' });
  const dispatcher = createClaudeDispatcher({ runProcess: runner, branchPrefix: 'agent/claude-' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs({ branch: 'main' })),
    /ORCHESTRATOR_SAFETY_VIOLATION/,
  );
  assert.equal(runner.calls.length, 0, 'must not invoke Claude when the target is unsafe');
});

test('rejects a branch that is not a dedicated Claude task branch', async () => {
  const dispatcher = dispatcherWith({ code: 0, stdout: OK_LINE(), stderr: '' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs({ branch: 'feature/whatever' })),
    /ORCHESTRATOR_DISPATCH_INVALID_INPUT/,
  );
});

test('rejects a missing/short base SHA', async () => {
  const dispatcher = dispatcherWith({ code: 0, stdout: OK_LINE(), stderr: '' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs({ baseSha: 'deadbeef' })),
    /ORCHESTRATOR_DISPATCH_INVALID_INPUT/,
  );
});

test('rejects when a mandatory safety constraint is missing from the packet request', async () => {
  const dispatcher = dispatcherWith({ code: 0, stdout: OK_LINE(), stderr: '' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs({ constraints: ['NO_MERGE_TO_MAIN'] })),
    /ORCHESTRATOR_DISPATCH_INVALID_INPUT/,
  );
});

test('a non-zero exit with no completion marker surfaces as ORCHESTRATOR_DISPATCH_FAILED', async () => {
  const dispatcher = dispatcherWith({ code: 1, stdout: 'boom', stderr: 'stack trace' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs()),
    /ORCHESTRATOR_DISPATCH_FAILED/,
  );
});

test('a runner that throws surfaces as ORCHESTRATOR_DISPATCH_FAILED, not a false success', async () => {
  const dispatcher = dispatcherWith(() => { throw new Error('spawn ENOENT'); });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs()),
    /ORCHESTRATOR_DISPATCH_FAILED/,
  );
});

test('no process argument or packet line is allowed to equal a protected branch', async () => {
  const runner = makeRunner({ code: 0, stdout: OK_LINE(), stderr: '' });
  const dispatcher = createClaudeDispatcher({ runProcess: runner, branchPrefix: 'agent/claude-' });
  await dispatcher.dispatchClaudeTask(baseArgs());
  const spec = runner.calls[0];
  for (const arg of spec.args ?? []) {
    assert.notEqual(arg, 'main');
    assert.notEqual(arg, 'master');
  }
});

// ---------------------------------------------------------------------------
// ChatGPT PR #19 review — Codex P2 (autonomous-claude-dispatch.mjs:156):
// a syntactically valid completion marker on a NONZERO exit must be rejected —
// the worker invocation did not succeed.
// ---------------------------------------------------------------------------

test('a valid completion marker on a nonzero exit is rejected (worker did not succeed)', async () => {
  const dispatcher = dispatcherWith({ code: 1, stdout: OK_LINE(), stderr: 'git push failed after tests passed' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs()),
    /ORCHESTRATOR_DISPATCH_FAILED/,
  );
});

test('a BLOCKED marker on a nonzero exit is also rejected — a clean block exits 0', async () => {
  const dispatcher = dispatcherWith({ code: 137, stdout: 'ALGOBOT_COMPLETION_JSON: {"completion":"BLOCKED","reason":"oom"}', stderr: 'Killed' });
  await assert.rejects(() => dispatcher.dispatchClaudeTask(baseArgs()), /ORCHESTRATOR_DISPATCH_FAILED/);
});

// ChatGPT PR #19 re-review 2 — Commit H: a detached kick-off result is a valid
// non-blocking outcome (DISPATCHED), not an unparseable completion.
test('a detached kick-off result is accepted as DISPATCHED, not parsed for a marker', async () => {
  const dispatcher = dispatcherWith({ code: null, stdout: '', stderr: '', detached: true, pid: 4242 });
  const out = await dispatcher.dispatchClaudeTask(baseArgs());
  assert.equal(out.completion, 'DISPATCHED');
});

// ChatGPT PR #19 re-review 3 (B2): a detached worker must carry a job identity
// (fence token + task + timestamp) so a stale worker's output is attributable.
test('the packet carries a JOB_ID when one is supplied', async () => {
  const runner = makeRunner({ code: 0, stdout: OK_LINE(), stderr: '' });
  const dispatcher = createClaudeDispatcher({ runProcess: runner, branchPrefix: 'agent/claude-' });
  await dispatcher.dispatchClaudeTask(baseArgs({ jobId: 'fence7-p0-task-4-1699999999' }));
  assert.match(runner.calls[0].input, /JOB_ID[=:\s]*fence7-p0-task-4-1699999999/);
});

// ChatGPT PR #19 re-review 3 (Copilot): a completion marker whose headSha is
// present but not a full 40-hex SHA must be rejected fail-closed.
test('a completion marker with a non-40-hex headSha is rejected', async () => {
  const dispatcher = dispatcherWith({ code: 0, stdout: 'ALGOBOT_COMPLETION_JSON: {"completion":"READY_FOR_CI","headSha":"abc123"}', stderr: '' });
  await assert.rejects(
    () => dispatcher.dispatchClaudeTask(baseArgs()),
    /ORCHESTRATOR_DISPATCH_UNPARSEABLE_COMPLETION/,
  );
});
