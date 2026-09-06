// Independent ChatGPT review adapter for the ALGOBOT autonomous orchestrator
// (spec: docs/superpowers/specs/2026-09-06-algobot-full-autonomous-orchestrator-design.md).
//
// Independent review is a HARD gate. This adapter sits behind an INJECTED,
// machine-invocable review client. It never embeds a fictional daemon and never
// substitutes Claude's own review: if no client is configured it returns a
// fail-closed stop state, and any verdict signed by a Claude-like / self
// identity is rejected. Every verdict is exact-SHA bound and goes stale on a
// new commit.

const ERR = Object.freeze({
  CONFIG: 'ORCHESTRATOR_REVIEW_INVALID_CONFIG',
  PACKET: 'ORCHESTRATOR_REVIEW_INVALID_PACKET',
  MALFORMED: 'ORCHESTRATOR_REVIEW_MALFORMED_VERDICT',
  STALE: 'ORCHESTRATOR_REVIEW_STALE_EVIDENCE',
  SELF: 'ORCHESTRATOR_REVIEW_SELF_SUBSTITUTION',
  REQUEST_FAILED: 'ORCHESTRATOR_REVIEW_REQUEST_FAILED',
});

const VALID_VERDICTS = new Set([
  'APPROVED_FOR_INTEGRATION',
  'CHANGES_REQUIRED',
  'HUMAN_APPROVAL_REQUIRED',
]);

const NO_REVIEWER = Object.freeze({
  status: 'NO_INDEPENDENT_REVIEWER',
  failClosed: true,
  stopState: 'READY_FOR_CHATGPT_REVIEW',
  reason: 'INDEPENDENT_REVIEW_ENDPOINT_NOT_CONFIGURED',
});

function fail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value.trim());
}

function looksLikeSelf(id, selfIdentities) {
  if (!isNonEmptyString(id)) return true; // an unsigned verdict is not independent
  if (selfIdentities.includes(id)) return true;
  return /\bclaude\b|self[-_ ]?review|anthropic|impl(ementation)?[-_ ]?bot/i.test(id);
}

export function createReviewGate(config = {}) {
  const { reviewClient = null, selfIdentities = [] } = config;

  if (reviewClient !== null && reviewClient !== undefined) {
    if (typeof reviewClient !== 'object'
      || typeof reviewClient.submitReviewRequest !== 'function'
      || typeof reviewClient.fetchReviewOutcome !== 'function') {
      fail(ERR.CONFIG, 'reviewClient must provide submitReviewRequest() and fetchReviewOutcome()');
    }
  }
  if (!Array.isArray(selfIdentities)) fail(ERR.CONFIG, 'selfIdentities must be an array');

  const configured = reviewClient !== null && reviewClient !== undefined;

  function assertIndependentIdentity(id) {
    if (looksLikeSelf(id, selfIdentities)) {
      fail(ERR.SELF, `reviewer identity "${id}" is not an independent reviewer`);
    }
  }

  function validatePacket(packet) {
    if (!packet || typeof packet !== 'object') fail(ERR.PACKET, 'review packet object required');
    if (!isNonEmptyString(packet.repo) || !packet.repo.includes('/')) fail(ERR.PACKET, 'packet.repo invalid');
    if (!Number.isInteger(packet.prNumber)) fail(ERR.PACKET, 'packet.prNumber must be an integer');
    if (!isFullSha(packet.headSha)) fail(ERR.PACKET, 'packet.headSha must be a full commit SHA');
    if (!packet.ciEvidence || typeof packet.ciEvidence !== 'object') fail(ERR.PACKET, 'packet.ciEvidence required');
    if (!isNonEmptyString(packet.ciEvidence.runId)) fail(ERR.PACKET, 'packet.ciEvidence.runId required');
    if (packet.ciEvidence.sha !== packet.headSha) {
      fail(ERR.PACKET, 'packet.ciEvidence.sha must equal packet.headSha (exact-SHA review)');
    }
    if (!isNonEmptyString(packet.acceptanceCriteria)) fail(ERR.PACKET, 'packet.acceptanceCriteria required');
  }

  function buildRequestPacket(packet) {
    return Object.freeze({
      repo: packet.repo,
      prNumber: packet.prNumber,
      headSha: packet.headSha,
      diffScope: Array.isArray(packet.diffScope) ? [...packet.diffScope] : [],
      acceptanceCriteria: packet.acceptanceCriteria,
      ciEvidence: Object.freeze({ ...packet.ciEvidence }),
      priorFindings: Array.isArray(packet.priorFindings) ? [...packet.priorFindings] : [],
      acceptedVerdicts: [...VALID_VERDICTS],
    });
  }

  async function requestIndependentReview(packet) {
    validatePacket(packet);
    if (!configured) return NO_REVIEWER;

    if (isNonEmptyString(reviewClient.reviewerId)) assertIndependentIdentity(reviewClient.reviewerId);

    const requestPacket = buildRequestPacket(packet);
    let response;
    try {
      response = await reviewClient.submitReviewRequest(requestPacket);
    } catch (error) {
      fail(ERR.REQUEST_FAILED, error && error.message ? error.message : String(error));
    }
    if (!response || !isNonEmptyString(response.requestId)) {
      fail(ERR.REQUEST_FAILED, 'review client returned no requestId');
    }

    return Object.freeze({
      status: 'REQUESTED',
      requestId: response.requestId,
      headSha: packet.headSha,
      clientStatus: response.status ?? null,
      submittedPacket: requestPacket,
    });
  }

  function validateReviewEvidence({ evidence, expectedSha } = {}) {
    if (!isFullSha(expectedSha)) fail(ERR.PACKET, 'expectedSha must be a full commit SHA');
    if (!evidence || typeof evidence !== 'object') fail(ERR.MALFORMED, 'evidence object required');
    if (!VALID_VERDICTS.has(evidence.verdict)) {
      fail(ERR.MALFORMED, `verdict "${evidence.verdict}" is not one of ${[...VALID_VERDICTS].join(', ')}`);
    }
    assertIndependentIdentity(evidence.reviewerId);
    if (!isFullSha(evidence.sha)) fail(ERR.MALFORMED, 'evidence.sha must be a full commit SHA');
    if (evidence.sha !== expectedSha) {
      fail(ERR.STALE, `evidence sha ${evidence.sha} != expected head ${expectedSha}`);
    }
    return Object.freeze({
      verdict: evidence.verdict,
      sha: evidence.sha,
      reviewerId: evidence.reviewerId,
      findings: Array.isArray(evidence.findings) ? [...evidence.findings] : [],
      submittedAt: evidence.submittedAt != null ? String(evidence.submittedAt) : null,
      matchesExpected: true,
    });
  }

  async function fetchReviewOutcome(requestId, expectedSha) {
    if (!configured) return NO_REVIEWER;
    if (!isNonEmptyString(requestId)) fail(ERR.PACKET, 'requestId is required');
    if (!isFullSha(expectedSha)) fail(ERR.PACKET, 'expectedSha must be a full commit SHA');

    let raw;
    try {
      raw = await reviewClient.fetchReviewOutcome(requestId);
    } catch (error) {
      fail(ERR.REQUEST_FAILED, error && error.message ? error.message : String(error));
    }
    if (raw === null || raw === undefined) {
      return Object.freeze({ status: 'PENDING', requestId });
    }
    const evidence = validateReviewEvidence({ evidence: raw, expectedSha });
    return Object.freeze({ status: 'COMPLETE', requestId, evidence });
  }

  return Object.freeze({
    configured,
    requestIndependentReview,
    fetchReviewOutcome,
    validateReviewEvidence,
    VALID_VERDICTS: Object.freeze([...VALID_VERDICTS]),
  });
}
