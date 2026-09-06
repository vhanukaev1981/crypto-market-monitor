import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGithubRestAdapter,
  createGithubFileLeaseStore,
  createGithubStateStore,
  createClaudeCliRunner,
  parseP0Plan,
} from '../algo/autonomous-orchestrator-adapters.mjs';

// ---------------------------------------------------------------------------
// ChatGPT PR #19 review — blocker 4: concrete GitHub / lease / Claude / plan
// adapters must exist behind `--live`. These test them with an INJECTED fetch /
// spawn so no real network or process is used.
// ---------------------------------------------------------------------------

const REPO = 'vhanukaev1981/crypto-market-monitor';
const TOKEN = 'ghp_fake';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function recordingFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) return typeof handler === 'function' ? handler(url, init) : handler;
    }
    return jsonResponse({ message: 'not found' }, { status: 404 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// -- config guards --------------------------------------------------------

test('every adapter factory fails closed without repo/token', () => {
  assert.throws(() => createGithubRestAdapter({ repo: '', token: TOKEN }), /ORCHESTRATOR_ADAPTER_NOT_CONFIGURED/);
  assert.throws(() => createGithubRestAdapter({ repo: REPO, token: '' }), /ORCHESTRATOR_ADAPTER_NOT_CONFIGURED/);
  assert.throws(() => createGithubFileLeaseStore({ repo: REPO, token: '' }), /ORCHESTRATOR_ADAPTER_NOT_CONFIGURED/);
  assert.throws(() => createGithubStateStore({ repo: '', token: TOKEN }), /ORCHESTRATOR_ADAPTER_NOT_CONFIGURED/);
});

test('the REST adapter refuses a protected integration target', async () => {
  const gh = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: recordingFetch([]) });
  await assert.rejects(() => gh.integratePr({ prNumber: 1, headSha: 'a'.repeat(40), target: 'main' }), /ORCHESTRATOR_SAFETY_VIOLATION/);
});

// -- GitHub REST reconciler surface ------------------------------------

test('getBranchHead returns the commit sha, or null on 404', async () => {
  const fetchImpl = recordingFetch([
    ['/git/ref/heads/agent%2Fclaude-x', jsonResponse({ object: { sha: 'b'.repeat(40) } })],
    ['/git/ref/heads/missing', jsonResponse({ message: 'Not Found' }, { status: 404 })],
  ]);
  const gh = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl });
  assert.equal(await gh.getBranchHead('agent/claude-x'), 'b'.repeat(40));
  assert.equal(await gh.getBranchHead('missing'), null);
});

test('getCiStatus classifies GREEN / FAILED / PENDING / NONE for a sha', async () => {
  const mk = (runs) => recordingFetch([['/check-runs', jsonResponse({ check_runs: runs })]]);
  const green = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: mk([{ name: 'c', status: 'completed', conclusion: 'success', id: 5, started_at: 't' }]) });
  assert.equal((await green.getCiStatus('a'.repeat(40), ['c'])).state, 'GREEN');
  const failed = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: mk([{ name: 'c', status: 'completed', conclusion: 'failure', id: 6 }]) });
  assert.equal((await failed.getCiStatus('a'.repeat(40), ['c'])).state, 'FAILED');
  const pending = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: mk([{ name: 'c', status: 'in_progress', conclusion: null, id: 7 }]) });
  assert.equal((await pending.getCiStatus('a'.repeat(40), ['c'])).state, 'PENDING');
  const none = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: mk([]) });
  assert.equal((await none.getCiStatus('a'.repeat(40), ['c'])).state, 'NONE');
});

test('isAncestor maps the compare API status to a boolean', async () => {
  const behind = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: recordingFetch([['/compare/', jsonResponse({ status: 'identical' })]]) });
  assert.equal(await behind.isAncestor('a'.repeat(40), 'agent/algobot-p0-persistent-recovery'), true);
  const diverged = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: recordingFetch([['/compare/', jsonResponse({ status: 'diverged' })]]) });
  assert.equal(await diverged.isAncestor('a'.repeat(40), 'agent/algobot-p0-persistent-recovery'), false);
});

test('a 5xx from GitHub surfaces as a transient reconcile failure', async () => {
  const gh = createGithubRestAdapter({ repo: REPO, token: TOKEN, fetchImpl: recordingFetch([['/git/ref/', jsonResponse({ message: 'bad gateway' }, { status: 502 })]]) });
  await assert.rejects(() => gh.getBranchHead('agent/claude-x'), /502|RECONCILE_FAILED|transient/i);
});

// -- GitHub-file lease store (compare-and-set) --------------------------

test('the lease store reads/writes a JSON file with compare-and-set on the blob sha', async () => {
  let file = null; // { content, sha }
  const fetchImpl = recordingFetch([
    ['/contents/', (url, init) => {
      if ((init.method || 'GET') === 'GET') {
        return file
          ? jsonResponse({ content: Buffer.from(JSON.stringify(file.content)).toString('base64'), sha: file.sha })
          : jsonResponse({ message: 'Not Found' }, { status: 404 });
      }
      const body = JSON.parse(init.body);
      if (file && body.sha !== file.sha) return jsonResponse({ message: 'sha mismatch' }, { status: 409 });
      file = { content: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), sha: `sha-${Math.random()}` };
      return jsonResponse({ content: {}, commit: {} });
    }],
  ]);
  const store = createGithubFileLeaseStore({ repo: REPO, token: TOKEN, path: 'ops/lease.json', fetchImpl });
  assert.equal(await store.readLease(), null);
  await store.writeLease({ state: 'HELD', holderId: 'a', fenceToken: 1 }, null);
  const back = await store.readLease();
  assert.equal(back.fenceToken, 1);
  await assert.rejects(() => store.writeLease({ state: 'HELD', holderId: 'b', fenceToken: 2 }, 999), /ORCHESTRATOR_LEASE_CONFLICT/);
});

// -- state store --------------------------------------------------------

test('the state store round-trips { snapshot, runtime }', async () => {
  let file = null;
  const fetchImpl = recordingFetch([
    ['/contents/', (url, init) => {
      if ((init.method || 'GET') === 'GET') {
        return file ? jsonResponse({ content: Buffer.from(JSON.stringify(file)).toString('base64'), sha: 'x' }) : jsonResponse({ message: 'nf' }, { status: 404 });
      }
      file = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
      return jsonResponse({});
    }],
  ]);
  const store = createGithubStateStore({ repo: REPO, token: TOKEN, path: 'ops/state.json', fetchImpl });
  assert.equal(await store.load(), null);
  await store.save({ snapshot: { state: 'CI_RUNNING' }, runtime: { reviewRequestId: 'rr' } });
  const back = await store.load();
  assert.equal(back.snapshot.state, 'CI_RUNNING');
  assert.equal(back.runtime.reviewRequestId, 'rr');
});

// -- Claude CLI runner -------------------------------------------------

test('the Claude CLI runner spawns the configured binary and captures stdout/stderr/exit', async () => {
  const spawnImpl = (cmd, args, opts) => {
    assert.equal(cmd, 'claude');
    const listeners = {};
    const child = {
      stdout: { on: (e, cb) => { if (e === 'data') cb(Buffer.from('ALGOBOT_COMPLETION_JSON: {"completion":"READY_FOR_CI"}')); } },
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} },
      on: (e, cb) => { listeners[e] = cb; if (e === 'close') setImmediate(() => cb(0)); },
      kill: () => {},
    };
    return child;
  };
  const run = createClaudeCliRunner({ claudeBin: 'claude', spawnImpl });
  const result = await run({ command: 'claude', args: ['-p'], input: 'packet', timeoutMs: 1000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /READY_FOR_CI/);
});

// -- P0 plan parser --------------------------------------------------

test('parseP0Plan extracts ordered tasks with dependencies, status and gate', () => {
  const md = [
    '# P0 Plan',
    '### Task 1 — Persistent schema (status: DONE)',
    'blah',
    '### Task 2 — Atomic CANARY budget (status: DONE) (depends: Task 1)',
    '### Task 3 — Executor Fencing (depends: Task 2)',
    '### Task 4 — Live canary rollout (depends: Task 3) (gate: LIVE_TRADING_GATE)',
  ].join('\n');
  const plan = parseP0Plan(md);
  assert.equal(plan.tasks.length, 4);
  assert.equal(plan.tasks[0].status, 'DONE');
  assert.deepEqual(plan.tasks[1].dependsOn, [plan.tasks[0].id]);
  assert.equal(plan.tasks[2].status, 'PENDING');
  assert.equal(plan.tasks[3].gate, 'LIVE_TRADING_GATE');
});

test('parseP0Plan defaults each task to depend on the previous one when none is stated', () => {
  const md = '### Task 1 — A\n### Task 2 — B\n### Task 3 — C';
  const plan = parseP0Plan(md);
  assert.deepEqual(plan.tasks[2].dependsOn, [plan.tasks[1].id]);
});

test('parseP0Plan on empty / non-plan text returns an empty task list, not a throw', () => {
  assert.deepEqual(parseP0Plan('no tasks here').tasks, []);
  assert.deepEqual(parseP0Plan('').tasks, []);
});
