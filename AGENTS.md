# AI Agent Engineering Policy

This repository may be worked on by GitHub Copilot, Codex, ChatGPT-connected agents, and human developers. All agents should follow the same engineering contract.

## Standard loop
Inspect -> define the smallest eligible task -> add/reproduce RED test -> implement -> GREEN -> regression -> review diff -> commit -> CI -> verify exact HEAD -> record evidence.

## Quality contract
- Evidence before completion claims.
- Tests must validate behavior, not merely implementation details.
- Fix root causes rather than masking symptoms.
- Keep commits small, reviewable, and task-scoped.
- Do not modify unrelated files.
- Avoid hidden state and nondeterministic behavior where practical.
- Make retries and repeated executions safe through idempotency where relevant.
- Reject malformed, ambiguous, stale, unauthorized, or unsafe inputs fail-closed on safety-sensitive paths.
- Never expose secrets in source, logs, artifacts, comments, prompts, or test fixtures.

## Review contract
Every substantive change should be checked for:
- functional correctness and regressions;
- security/auth boundaries;
- concurrency/race conditions;
- persistence and restart/recovery behavior;
- idempotency/duplicate side effects;
- data validation and integrity;
- error paths and observability;
- adequate automated tests;
- CI coverage for the changed path.

## Human governance boundaries
Agents may autonomously perform reversible development work when authorized, but must not independently perform irreversible or security-sensitive production actions. Never merge to `main`, activate production trading, rotate/delete credentials, change billing, or perform destructive production operations without explicit human authorization.

## ALGOBOT-specific invariant
ALGOBOT work is Paper-Trading/development-only unless explicitly governed otherwise. Live/Mainnet execution and leverage remain prohibited. Existing drawdown/exposure controls and blind-OOS governance are safety invariants, not optimization targets.
