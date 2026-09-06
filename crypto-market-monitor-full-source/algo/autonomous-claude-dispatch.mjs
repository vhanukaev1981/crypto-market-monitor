// Claude non-interactive dispatch adapter for the ALGOBOT autonomous
// orchestrator (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Builds an exact-SHA-bound task packet, invokes Claude Code non-interactively
// through an INJECTED process runner (never a live Claude session here), and
// accepts ONLY machine-readable completion markers. Free-form prose is never a
// success. Claude may push only its dedicated task branch; it can never be
// pointed at `main`.

import { isProtectedBranch } from './autonomous-orchestrator-state.mjs';

const ERR = Object.freeze({
  INPUT: 'ORCHESTRATOR_DISPATCH_INVALID_INPUT',
  SAFETY: 'ORCHESTRATOR_SAFETY_VIOLATION',
  UNPARSEABLE: 'ORCHESTRATOR_DISPATCH_UNPARSEABLE_COMPLETION',
  FAILED: 'ORCHESTRATOR_DISPATCH_FAILED',
});

const ALLOWED_COMPLETIONS = new Set([
  'READY_FOR_CI',
  'READY_FOR_CHATGPT_REVIEW',
  'CHANGES_APPLIED',
  'BLOCKED',
]);

const MANDATORY_CONSTRAINTS = Object.freeze([
  'NO_MERGE_TO_MAIN',
  'NO_REAL_BYBIT_ORDER',
  'PRESERVE_CANARY_LIMITS',
  'STRICT_RED_GREEN_TDD',
]);

const COMPLETION_MARKER = 'ALGOBOT_COMPLETION_JSON';
const COMPLETION_RE = /^ALGOBOT_COMPLETION_JSON:\s*(\{.*\})\s*$/m;

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeCriteria(value) {
  if (Array.isArray(value)) return value.filter(isNonEmptyString).join('\n- ');
  return isNonEmptyString(value) ? value : null;
}

export function createClaudeDispatcher(config = {}) {
  const {
    runProcess,
    branchPrefix = 'agent/claude-',
    claudeCommand = 'claude',
    claudeArgs = ['-p', '--output-format', 'text'],
    timeoutMs = 3_600_000,
  } = config;

  if (typeof runProcess !== 'function') fail(ERR.INPUT, 'runProcess must be a function');
  if (!isNonEmptyString(branchPrefix)) fail(ERR.INPUT, 'branchPrefix must be a non-empty string');
  if (!Array.isArray(claudeArgs) || claudeArgs.some((a) => isProtectedBranch(a))) {
    fail(ERR.SAFETY, 'claudeArgs must not name a protected branch');
  }

  function buildPacket({ task, baseSha, branch, acceptanceCriteria, constraints, attempt, priorFindings }) {
    const findingsBlock = Array.isArray(priorFindings) && priorFindings.length
      ? `\nPRIOR FINDINGS TO ADDRESS:\n- ${priorFindings.map(String).join('\n- ')}\n`
      : '';
    return [
      '# ALGOBOT AUTONOMOUS TASK PACKET',
      `REPOSITORY=${task.repository ?? '(unset)'}`,
      `TASK_ID=${task.id}`,
      `BASE_SHA=${baseSha}`,
      `BRANCH=${branch}`,
      `ATTEMPT=${attempt}`,
      findingsBlock,
      'ACCEPTANCE CRITERIA:',
      `- ${acceptanceCriteria}`,
      '',
      'TDD RULES (mandatory):',
      '- Write failing RED tests first and preserve the RED evidence.',
      '- Implement the minimum production change to reach GREEN.',
      '- Run the relevant regression suite; commit test + implementation together.',
      '',
      'SAFETY CONSTRAINTS (mandatory, fail closed):',
      ...constraints.map((c) => `- ${c}`),
      `- You may push ONLY the branch ${branch}. Never write, merge, or target main/master.`,
      '',
      'COMPLETION PROTOCOL:',
      `- Emit exactly one line: ${COMPLETION_MARKER}: {"completion":"<VERDICT>","headSha":"<sha>","pr":<number>}`,
      '- <VERDICT> is one of READY_FOR_CI | READY_FOR_CHATGPT_REVIEW | CHANGES_APPLIED | BLOCKED.',
      '- For BLOCKED include a "reason" field. Prose without this line is NOT a completion.',
    ].join('\n');
  }

  function parseCompletion(stdout) {
    const match = typeof stdout === 'string' ? stdout.match(COMPLETION_RE) : null;
    if (!match) return null;
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      return { invalid: true };
    }
    if (!parsed || typeof parsed !== 'object' || !ALLOWED_COMPLETIONS.has(parsed.completion)) {
      return { invalid: true };
    }
    return { parsed };
  }

  async function dispatchClaudeTask(request = {}) {
    const { task, baseSha, branch, acceptanceCriteria, constraints, attempt, priorFindings } = request;

    if (!task || typeof task !== 'object' || !isNonEmptyString(task.id)) fail(ERR.INPUT, 'task.id is required');
    if (!isNonEmptyString(branch)) fail(ERR.INPUT, 'branch is required');
    if (isProtectedBranch(branch)) fail(ERR.SAFETY, `refusing to dispatch against protected branch ${branch}`);
    if (!branch.startsWith(branchPrefix)) {
      fail(ERR.INPUT, `branch ${branch} is not a dedicated Claude task branch (${branchPrefix}*)`);
    }
    if (!isNonEmptyString(baseSha) || !/^[0-9a-f]{40}$/i.test(baseSha.trim())) {
      fail(ERR.INPUT, 'baseSha must be a full 40-hex commit SHA');
    }
    const criteria = normalizeCriteria(acceptanceCriteria);
    if (!criteria) fail(ERR.INPUT, 'acceptanceCriteria is required');
    if (!Array.isArray(constraints)) fail(ERR.INPUT, 'constraints must be an array');
    for (const required of MANDATORY_CONSTRAINTS) {
      if (!constraints.includes(required)) fail(ERR.INPUT, `constraints must include ${required}`);
    }
    if (!Number.isInteger(attempt) || attempt < 1) fail(ERR.INPUT, 'attempt must be a positive integer');

    const packet = buildPacket({ task, baseSha, branch, acceptanceCriteria: criteria, constraints, attempt, priorFindings });

    // Defence in depth: nothing handed to the process may name a protected branch.
    for (const arg of claudeArgs) {
      if (isProtectedBranch(arg)) fail(ERR.SAFETY, 'process argument names a protected branch');
    }

    const spec = {
      command: claudeCommand,
      args: [...claudeArgs],
      input: packet,
      cwd: task.cwd,
      timeoutMs,
    };

    let result;
    try {
      result = await runProcess(spec);
    } catch (error) {
      fail(ERR.FAILED, error && error.message ? error.message : String(error));
    }
    if (!result || typeof result !== 'object') fail(ERR.FAILED, 'runProcess returned no result');

    const completion = parseCompletion(result.stdout);
    if (!completion) {
      if (Number(result.code) !== 0) {
        fail(ERR.FAILED, `exit ${result.code} with no completion marker`);
      }
      fail(ERR.UNPARSEABLE, 'no ALGOBOT_COMPLETION_JSON line in Claude output');
    }
    if (completion.invalid) fail(ERR.UNPARSEABLE, 'completion marker present but malformed or unknown verdict');

    const parsed = completion.parsed;
    const prNumber = Number.isInteger(parsed.pr) ? parsed.pr
      : Number.isInteger(parsed.prNumber) ? parsed.prNumber
        : null;

    return Object.freeze({
      completion: parsed.completion,
      branch,
      baseSha,
      attempt,
      headSha: isNonEmptyString(parsed.headSha) ? parsed.headSha : null,
      prNumber,
      reason: isNonEmptyString(parsed.reason) ? parsed.reason : null,
      raw: Object.freeze({ code: result.code ?? null }),
    });
  }

  return Object.freeze({ dispatchClaudeTask, MANDATORY_CONSTRAINTS });
}

export { MANDATORY_CONSTRAINTS };
