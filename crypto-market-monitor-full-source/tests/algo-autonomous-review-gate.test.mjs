import test from 'node:test';
import assert from 'node:assert/strict';

import { createReviewGate } from '../algo/autonomous-review-gate.mjs';

// ---------------------------------------------------------------------------
// Task 6 — Independent ChatGPT review adapter (RED).
//
// createReviewGate({ reviewClient, selfIdentities }) exposes:
//   requestIndependentReview(packet)
//   fetchReviewOutcome(requestId, expectedSha)
//   validateReviewEvidence({ evidence, expectedSha })
//
// Independent review is a hard gate. If no machine-invocable review client is
// configured the gate returns a FAIL-CLOSED stop state — it never substitutes
// Claude's own review. Every verdict is exact-SHA bound and goes stale on a new
// commit.
// ---------------------------------------------------------------------------

const HEAD = 'e5'.repeat(20);
const OLD = 'f6'.repeat(20);

function packet(overrides = {}) {
  return {
    repo: 'vhanukaev1981/crypto-market-monitor',
    prNumber: 18,
    headSha: HEAD,
    diffScope: ['crypto-market-monitor-full-source/algo/foo.mjs'],
    acceptanceCriteria: 'Executor fencing with RED/GREEN evidence.',
    ciEvidence: { runId: 'run-777', sha: HEAD },
    priorFindings: [],
    ...overrides,
  };
}

function fakeReviewClient(overrides = {}) {
  const calls = { submit: 0, fetch: 0 };
  return {
    _calls: calls,
    reviewerId: 'chatgpt-independent-reviewer',
    async submitReviewRequest(p) { calls.submit += 1; return { requestId: 'rr-1', status: 'QUEUED', echo: p }; },
    async fetchReviewOutcome(/* requestId */) { calls.fetch += 1; return null; },
    ...overrides,
  };
}

test('requestIndependentReview submits an exact-SHA packet to the injected client', async () => {
  const client = fakeReviewClient();
  const gate = createReviewGate({ reviewClient: client });
  const out = await gate.requestIndependentReview(packet());
  assert.equal(out.status, 'REQUESTED');
  assert.equal(out.requestId, 'rr-1');
  assert.equal(out.headSha, HEAD);
  assert.equal(client._calls.submit, 1);
});

test('a packet whose CI evidence SHA != head SHA is rejected', async () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  await assert.rejects(
    () => gate.requestIndependentReview(packet({ ciEvidence: { runId: 'r', sha: OLD } })),
    /ORCHESTRATOR_REVIEW_INVALID_PACKET/,
  );
});

test('NO review client configured -> fail-closed stop state, never Claude self-review', async () => {
  const gate = createReviewGate({ reviewClient: null });
  const out = await gate.requestIndependentReview(packet());
  assert.equal(out.status, 'NO_INDEPENDENT_REVIEWER');
  assert.equal(out.failClosed, true);
  assert.equal(out.stopState, 'READY_FOR_CHATGPT_REVIEW');
});

test('a review client whose identity looks like Claude is rejected as self-substitution', async () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient({ reviewerId: 'claude-code-worker' }) });
  await assert.rejects(
    () => gate.requestIndependentReview(packet()),
    /ORCHESTRATOR_REVIEW_SELF_SUBSTITUTION/,
  );
});

test('an explicitly self identity is rejected as self-substitution', async () => {
  const gate = createReviewGate({
    reviewClient: fakeReviewClient({ reviewerId: 'orchestrator-impl-bot' }),
    selfIdentities: ['orchestrator-impl-bot'],
  });
  await assert.rejects(() => gate.requestIndependentReview(packet()), /ORCHESTRATOR_REVIEW_SELF_SUBSTITUTION/);
});

test('validateReviewEvidence accepts APPROVED_FOR_INTEGRATION on the exact head SHA', () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  const v = gate.validateReviewEvidence({
    evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt-independent-reviewer', findings: [] },
    expectedSha: HEAD,
  });
  assert.equal(v.verdict, 'APPROVED_FOR_INTEGRATION');
  assert.equal(v.matchesExpected, true);
});

test('validateReviewEvidence accepts CHANGES_REQUIRED and carries the findings', () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  const v = gate.validateReviewEvidence({
    evidence: { verdict: 'CHANGES_REQUIRED', sha: HEAD, reviewerId: 'chatgpt', findings: ['fix the race'] },
    expectedSha: HEAD,
  });
  assert.equal(v.verdict, 'CHANGES_REQUIRED');
  assert.deepEqual(v.findings, ['fix the race']);
});

test('validateReviewEvidence accepts HUMAN_APPROVAL_REQUIRED', () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  const v = gate.validateReviewEvidence({
    evidence: { verdict: 'HUMAN_APPROVAL_REQUIRED', sha: HEAD, reviewerId: 'chatgpt' },
    expectedSha: HEAD,
  });
  assert.equal(v.verdict, 'HUMAN_APPROVAL_REQUIRED');
});

test('a stale approval (verdict for an older SHA) is rejected', () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  assert.throws(
    () => gate.validateReviewEvidence({
      evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: OLD, reviewerId: 'chatgpt' },
      expectedSha: HEAD,
    }),
    /ORCHESTRATOR_REVIEW_STALE_EVIDENCE/,
  );
});

test('a malformed / unknown verdict is rejected', () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  for (const verdict of ['LGTM', 'approve', 'APPROVED', undefined, '']) {
    assert.throws(
      () => gate.validateReviewEvidence({ evidence: { verdict, sha: HEAD, reviewerId: 'chatgpt' }, expectedSha: HEAD }),
      /ORCHESTRATOR_REVIEW_MALFORMED_VERDICT/,
    );
  }
});

test('review evidence signed by a Claude-like reviewer is rejected as self-substitution', () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  assert.throws(
    () => gate.validateReviewEvidence({
      evidence: { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'claude-sonnet-self-review' },
      expectedSha: HEAD,
    }),
    /ORCHESTRATOR_REVIEW_SELF_SUBSTITUTION/,
  );
});

test('fetchReviewOutcome returns PENDING while the client has no outcome yet', async () => {
  const gate = createReviewGate({ reviewClient: fakeReviewClient() });
  const out = await gate.fetchReviewOutcome('rr-1', HEAD);
  assert.equal(out.status, 'PENDING');
});

test('fetchReviewOutcome validates a completed outcome against the expected head SHA', async () => {
  const client = fakeReviewClient({
    async fetchReviewOutcome() {
      return { verdict: 'APPROVED_FOR_INTEGRATION', sha: HEAD, reviewerId: 'chatgpt' };
    },
  });
  const gate = createReviewGate({ reviewClient: client });
  const out = await gate.fetchReviewOutcome('rr-1', HEAD);
  assert.equal(out.status, 'COMPLETE');
  assert.equal(out.evidence.verdict, 'APPROVED_FOR_INTEGRATION');
});

test('fetchReviewOutcome rejects a completed outcome bound to a stale SHA', async () => {
  const client = fakeReviewClient({
    async fetchReviewOutcome() { return { verdict: 'APPROVED_FOR_INTEGRATION', sha: OLD, reviewerId: 'chatgpt' }; },
  });
  const gate = createReviewGate({ reviewClient: client });
  await assert.rejects(() => gate.fetchReviewOutcome('rr-1', HEAD), /ORCHESTRATOR_REVIEW_STALE_EVIDENCE/);
});

test('fetchReviewOutcome with no client configured -> fail-closed, never a synthesized approval', async () => {
  const gate = createReviewGate({ reviewClient: null });
  const out = await gate.fetchReviewOutcome('rr-1', HEAD);
  assert.equal(out.status, 'NO_INDEPENDENT_REVIEWER');
  assert.equal(out.failClosed, true);
});

test('a review client missing required methods is rejected at construction', () => {
  assert.throws(() => createReviewGate({ reviewClient: { reviewerId: 'x' } }), /ORCHESTRATOR_REVIEW_INVALID_CONFIG/);
});
