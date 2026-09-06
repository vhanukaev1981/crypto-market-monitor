// Concrete live adapters for the ALGOBOT autonomous orchestrator daemon
// (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Every adapter takes an INJECTED transport (`fetchImpl` / `spawnImpl`) so it is
// unit-tested without real network or process IO. `scripts/run-autonomous-orchestrator.mjs`
// wires these from the host environment under `--live`; nothing here contains
// orchestration or safety-decision logic (that stays in Tasks 1-8).

import { isProtectedBranch } from './autonomous-orchestrator-state.mjs';

const ERR = Object.freeze({
  CONFIG: 'ORCHESTRATOR_ADAPTER_NOT_CONFIGURED',
  SAFETY: 'ORCHESTRATOR_SAFETY_VIOLATION',
  TRANSIENT: 'ORCHESTRATOR_RECONCILE_FAILED',
  CAS: 'ORCHESTRATOR_ADAPTER_CAS_CONFLICT',
  AUTH: 'ORCHESTRATOR_ADAPTER_AUTH',
  INPUT: 'ORCHESTRATOR_ADAPTER_INVALID_INPUT',
});

const CONTROL_ERR = 'ORCHESTRATOR_STALE_FENCE';

function requireControlBranch(controlBranch) {
  if (!isNonEmptyString(controlBranch)) fail(ERR.CONFIG, 'controlBranch is required (a dedicated non-default branch)');
  if (isProtectedBranch(controlBranch)) fail(ERR.SAFETY, `controlBranch ${controlBranch} is a protected / default branch`);
}

const PASS = new Set(['success', 'neutral', 'skipped']);

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function b64encode(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64decode(str) { return Buffer.from(str, 'base64').toString('utf8'); }

function requireConfig(repo, token) {
  if (!isNonEmptyString(repo) || !repo.includes('/')) fail(ERR.CONFIG, 'repo must be "owner/repo"');
  if (!isNonEmptyString(token)) fail(ERR.CONFIG, 'a GitHub token is required');
}

function githubTransport(repo, token, fetchImpl) {
  const base = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'algobot-orchestrator',
  };
  async function call(path, init = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    // Auth failures are NOT transient — never retry them into a silent loop.
    if (res.status === 401 || res.status === 403) fail(ERR.AUTH, `GitHub ${res.status} on ${path}`);
    if (res.status >= 500) fail(ERR.TRANSIENT, `GitHub ${res.status} on ${path}`);
    return res;
  }
  return { call };
}

// All control-plane reads/writes are pinned to a dedicated non-default branch.
// `leaseCheck` (if provided) re-verifies the lease fence at commit time.
function githubFiles(repo, token, fetchImpl, { controlBranch, leaseCheck } = {}) {
  requireControlBranch(controlBranch);
  const { call } = githubTransport(repo, token, fetchImpl);
  return {
    controlBranch,
    async getFile(path) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await call(`/contents/${path}${sep}ref=${encodeURIComponent(controlBranch)}`);
      if (res.status === 404) return null;
      if (!res.ok) fail(ERR.TRANSIENT, `contents GET ${res.status}`);
      const body = await res.json();
      let content = null;
      try { content = JSON.parse(b64decode(body.content)); } catch { content = null; }
      return { content, sha: body.sha };
    },
    async putFile(path, obj, expectedSha) {
      if (typeof leaseCheck === 'function') await leaseCheck(); // fence at commit time
      if (isProtectedBranch(controlBranch)) fail(ERR.SAFETY, `refusing to write to ${controlBranch}`);
      const res = await call(`/contents/${path}`, {
        method: 'PUT',
        body: {
          message: `orchestrator: update ${path}`,
          content: b64encode(JSON.stringify(obj, null, 2)),
          branch: controlBranch,
          ...(expectedSha ? { sha: expectedSha } : {}),
        },
      });
      if (res.status === 409) fail(ERR.CAS, `contents PUT 409 on ${path}`);
      if (!res.ok) fail(ERR.TRANSIENT, `contents PUT ${res.status}`);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// GitHub REST adapter — the reconciler surface + mutators + integration ledger
// ---------------------------------------------------------------------------

export function createGithubRestAdapter(config = {}) {
  const {
    repo,
    token,
    fetchImpl = globalThis.fetch,
    controlBranch,
    trustedReviewers = [],
    leaseCheck,
    integrationLedgerPath = 'autonomous-integration-ledger.json',
    statusPath = 'autonomous-orchestrator-status.json',
  } = config;
  requireConfig(repo, token);
  if (typeof fetchImpl !== 'function') fail(ERR.CONFIG, 'fetchImpl must be a function');
  requireControlBranch(controlBranch);
  if (!Array.isArray(trustedReviewers)) fail(ERR.CONFIG, 'trustedReviewers must be an array of GitHub logins');

  const owner = repo.split('/')[0];
  const { call } = githubTransport(repo, token, fetchImpl);
  const files = githubFiles(repo, token, fetchImpl, { controlBranch, leaseCheck });

  async function getBranchHead(branch) {
    const res = await call(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (res.status === 404) return null;
    if (!res.ok) fail(ERR.TRANSIENT, `git/ref ${res.status}`);
    const body = await res.json();
    return body && body.object ? body.object.sha : null;
  }

  async function getOpenPullRequest({ headBranch, baseBranch }) {
    const res = await call(`/pulls?state=all&head=${owner}:${headBranch}&base=${baseBranch}&per_page=1`);
    if (!res.ok) fail(ERR.TRANSIENT, `pulls ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return null;
    const pr = list[0];
    return {
      number: pr.number,
      headSha: pr.head && pr.head.sha,
      headRef: pr.head && pr.head.ref,
      baseRef: pr.base && pr.base.ref,
      state: pr.state,
      merged: !!(pr.merged || pr.merged_at),
    };
  }

  async function getCiStatus(sha, requiredChecks = []) {
    if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
      fail(ERR.INPUT, 'getCiStatus needs a non-empty requiredChecks list (empty = unsafe)');
    }
    const res = await call(`/commits/${sha}/check-runs?per_page=100`);
    if (!res.ok) fail(ERR.TRANSIENT, `check-runs ${res.status}`);
    const body = await res.json();
    const all = Array.isArray(body.check_runs) ? body.check_runs : [];
    // Per-check breakdown, one call. A required check with no run is 'missing'.
    const checks = requiredChecks.map((name) => {
      const forName = all.filter((r) => r.name === name);
      if (forName.length === 0) return { name, headSha: sha, status: 'missing', conclusion: null, runId: null };
      const latest = forName.reduce((a, b) => ((b.started_at || '') >= (a.started_at || '') ? b : a));
      return {
        name,
        headSha: sha,
        status: latest.status,
        conclusion: latest.conclusion ?? null,
        runId: latest.id != null ? String(latest.id) : null,
        startedAt: latest.started_at || null,
      };
    });
    let state;
    if (checks.some((c) => c.status === 'missing')) state = 'NONE';
    else if (checks.some((c) => c.status !== 'completed')) state = 'PENDING';
    else if (checks.some((c) => !PASS.has(c.conclusion))) state = 'FAILED';
    else state = 'GREEN';
    const latestRunId = checks.map((c) => c.runId).filter(Boolean).sort().pop() || null;
    return { sha, state, runId: latestRunId, checks };
  }

  async function getReviewVerdict(prNumber) {
    const res = await call(`/issues/${prNumber}/comments?per_page=100`);
    if (!res.ok) fail(ERR.TRANSIENT, `comments ${res.status}`);
    const comments = await res.json();
    if (!Array.isArray(comments)) return null;
    let latest = null;
    for (const c of comments) {
      if (typeof c.body !== 'string') continue;
      const author = c.user && c.user.login;
      // Only a marker from an allow-listed reviewer is canonical evidence.
      if (!author || !trustedReviewers.includes(author)) continue;
      if (!/ALGOBOT_REVIEW_VERDICT:/.test(c.body)) continue;
      const m = c.body.match(/ALGOBOT_REVIEW_VERDICT:\s*(\{[\s\S]*?\})\s*(?:$|\n)/);
      let parsed = null;
      if (m) { try { parsed = JSON.parse(m[1]); } catch { parsed = null; } }
      if (parsed && typeof parsed === 'object') {
        latest = {
          verdict: parsed.verdict,
          sha: parsed.sha,
          reviewerId: author,
          evidenceUrl: c.html_url,
          submittedAt: c.created_at,
        };
      } else {
        // A marker present but unparseable from a TRUSTED author is surfaced.
        latest = { malformed: true, reviewerId: author, evidenceUrl: c.html_url, submittedAt: c.created_at };
      }
    }
    return latest;
  }

  async function isAncestor(sha, branch) {
    const res = await call(`/compare/${encodeURIComponent(branch)}...${sha}`);
    if (res.status === 404) return false;
    if (!res.ok) fail(ERR.TRANSIENT, `compare ${res.status}`);
    const body = await res.json();
    return body.status === 'identical' || body.status === 'behind';
  }

  async function integratePr({ prNumber, headSha, target }) {
    if (isProtectedBranch(target)) fail(ERR.SAFETY, `integratePr target ${target} is a protected branch`);
    const res = await call(`/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: { merge_method: 'merge', sha: headSha },
    });
    if (!res.ok) fail(ERR.TRANSIENT, `merge ${res.status}`);
    return { merged: true };
  }

  async function recordIntegration(taskId, head) {
    const cur = await files.getFile(integrationLedgerPath);
    const ledger = (cur && cur.content && typeof cur.content === 'object') ? cur.content : { integrated: {} };
    ledger.integrated = ledger.integrated || {};
    ledger.integrated[taskId] = { head, at: new Date().toISOString() };
    await files.putFile(integrationLedgerPath, ledger, cur ? cur.sha : undefined);
  }

  const integrationLedger = {
    async hasIntegratedTask(taskId) {
      const cur = await files.getFile(integrationLedgerPath);
      return !!(cur && cur.content && cur.content.integrated && cur.content.integrated[taskId]);
    },
    async getIntegratedHead(taskId) {
      const cur = await files.getFile(integrationLedgerPath);
      const e = cur && cur.content && cur.content.integrated && cur.content.integrated[taskId];
      return e ? e.head : null;
    },
  };

  async function createBranchRef(newBranch, fromSha) {
    if (isProtectedBranch(newBranch)) fail(ERR.SAFETY, `refusing to create protected branch ${newBranch}`);
    const res = await call('/git/refs', { method: 'POST', body: { ref: `refs/heads/${newBranch}`, sha: fromSha } });
    if (res.status === 422) return { created: false, reason: 'exists' }; // idempotent
    if (!res.ok) fail(ERR.TRANSIENT, `create ref ${res.status}`);
    return { created: true };
  }

  async function readCursor() {
    const cur = await files.getFile('autonomous-orchestrator-task-cursor.json');
    return cur && cur.content ? cur.content : null;
  }
  async function writeCursor(cursor) {
    const cur = await files.getFile('autonomous-orchestrator-task-cursor.json');
    await files.putFile('autonomous-orchestrator-task-cursor.json', cursor, cur ? cur.sha : undefined);
  }
  async function appendReviewEvidence(record) {
    const cur = await files.getFile('autonomous-review-evidence.json');
    const log = (cur && cur.content && Array.isArray(cur.content.records)) ? cur.content : { records: [] };
    log.records.push({ ...record, at: new Date().toISOString() });
    await files.putFile('autonomous-review-evidence.json', log, cur ? cur.sha : undefined);
  }

  const mutators = {
    integratePr: async (args) => {
      const out = await integratePr(args);
      // The ledger entry IS the durable integration evidence — a write failure
      // must propagate, not be swallowed.
      if (!args.taskId) fail(ERR.INPUT, 'integratePr requires taskId for the durable integration ledger');
      await recordIntegration(args.taskId, args.headSha);
      return out;
    },
    async postStatus(status) {
      const cur = await files.getFile(statusPath);
      await files.putFile(statusPath, status, cur ? cur.sha : undefined);
    },
    async recordReviewRequest(req) {
      await appendReviewEvidence({ kind: 'request', requestId: req && req.requestId, headSha: req && req.headSha });
    },
    async recordApproval(evidence) {
      await appendReviewEvidence({ kind: 'verdict', ...evidence });
    },
    async recordNextTask({ taskId, branch, baseSha }) {
      await createBranchRef(branch, baseSha);
      await writeCursor({ currentTaskId: taskId, currentBranch: branch, baseSha, at: new Date().toISOString() });
    },
  };

  return {
    controlBranch,
    getBranchHead,
    getOpenPullRequest,
    getCiStatus,
    getReviewVerdict,
    isAncestor,
    integratePr, // raw; enforces the protected-branch guard
    recordIntegration,
    createBranchRef,
    readCursor,
    writeCursor,
    integrationLedger,
    mutators,
  };
}

// ---------------------------------------------------------------------------
// GitHub-file lease store (compare-and-set) for createOrchestratorLease
// ---------------------------------------------------------------------------

export function createGithubFileLeaseStore(config = {}) {
  const { repo, token, path = 'autonomous-orchestrator-lease.json', fetchImpl = globalThis.fetch, controlBranch } = config;
  requireConfig(repo, token);
  const files = githubFiles(repo, token, fetchImpl, { controlBranch });

  return {
    controlBranch,
    async readLease() {
      const f = await files.getFile(path);
      return f && f.content ? f.content : null;
    },
    async writeLease(next, expectedFenceToken) {
      const cur = await files.getFile(path);
      const curToken = cur && cur.content ? (cur.content.fenceToken ?? null) : null;
      if (curToken !== (expectedFenceToken ?? null)) {
        throw new Error('ORCHESTRATOR_LEASE_CONFLICT: fence token mismatch');
      }
      try {
        await files.putFile(path, next === null ? { state: 'RELEASED' } : next, cur ? cur.sha : undefined);
      } catch (e) {
        if (e.message.startsWith(ERR.CAS)) throw new Error('ORCHESTRATOR_LEASE_CONFLICT: concurrent write');
        throw e;
      }
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// GitHub-file durable state store for the loop's { snapshot, runtime }
// ---------------------------------------------------------------------------

export function createGithubStateStore(config = {}) {
  const { repo, token, path = 'autonomous-orchestrator-state.json', fetchImpl = globalThis.fetch, controlBranch, leaseCheck } = config;
  requireConfig(repo, token);
  const files = githubFiles(repo, token, fetchImpl, { controlBranch, leaseCheck });

  return {
    controlBranch,
    async load() {
      const f = await files.getFile(path);
      return f && f.content ? f.content : null;
    },
    async save(blob) {
      const cur = await files.getFile(path);
      await files.putFile(path, blob, cur ? cur.sha : undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Claude CLI runner -> runProcess({ command, args, input, cwd, timeoutMs })
// ---------------------------------------------------------------------------

export function createClaudeCliRunner(config = {}) {
  const { claudeBin = 'claude', spawnImpl } = config;
  let spawn = spawnImpl;
  if (typeof spawn !== 'function') {
    // Lazy import so the module loads without node:child_process in a browser test.
    spawn = (...a) => import('node:child_process').then((m) => m.spawn(...a));
  }

  return async function runProcess({ command, args = [], input, cwd, timeoutMs = 3_600_000 } = {}) {
    const child = await spawn(command || claudeBin, args, { cwd });
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = timeoutMs
        ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } reject(new Error('ORCHESTRATOR_CLAUDE_RUNNER_TIMEOUT')); }, timeoutMs)
        : null;
      if (child.stdout && child.stdout.on) child.stdout.on('data', (d) => { stdout += d.toString(); });
      if (child.stderr && child.stderr.on) child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
      child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
      if (input && child.stdin && child.stdin.write) { child.stdin.write(input); child.stdin.end(); }
    });
  };
}

// ---------------------------------------------------------------------------
// P0 plan parser -> { tasks: [{ id, dependsOn, status, gate }] }
// ---------------------------------------------------------------------------

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseP0Plan(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return { tasks: [] };
  // Tolerate ~~strike~~ / **bold** decoration between the heading hashes and "Task".
  const headingRe = /^#{1,6}\s*[~*_\s]*Task\s+(\d+)\s*[—:-]\s*(.+?)\s*$/gm;
  const DONE_RE = /~~|\*\*\s*DONE\s*\*\*|__\s*DONE\s*__|\(\s*status:\s*done\s*\)/i;
  const raw = [];
  let m;
  while ((m = headingRe.exec(markdown)) !== null) {
    const number = Number(m[1]);
    const line = m[2];
    const statusM = line.match(/status:\s*([A-Za-z_]+)/i);
    const gateM = line.match(/gate:\s*([A-Z_]+)/);
    const dependsM = line.match(/depends:\s*([^)]+)/i);
    const isDone = DONE_RE.test(line) || (statusM && statusM[1].toUpperCase() === 'DONE');
    raw.push({
      number,
      title: line.replace(/~~/g, '').replace(/\*\*[^*]*\*\*/g, '').replace(/\([^)]*\)/g, '').trim(),
      status: isDone ? 'DONE' : (statusM ? statusM[1].toUpperCase() : 'PENDING'),
      gate: gateM ? gateM[1] : null,
      dependsNumbers: dependsM
        ? dependsM[1].split(',').map((s) => Number((s.match(/\d+/) || [])[0])).filter((n) => Number.isInteger(n))
        : null,
    });
  }
  const byNumber = new Map();
  const tasks = raw.map((t) => {
    const id = `task-${t.number}-${slug(t.title) || 'unnamed'}`;
    byNumber.set(t.number, id);
    return { ...t, id };
  });
  return {
    tasks: tasks.map((t, i) => ({
      id: t.id,
      status: t.status,
      gate: t.gate,
      dependsOn: t.dependsNumbers
        ? t.dependsNumbers.map((n) => byNumber.get(n)).filter(Boolean)
        : (i > 0 ? [tasks[i - 1].id] : []),
    })),
  };
}
