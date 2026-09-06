# Bybit Non-US Runtime Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a controlled non-US Linux runtime with a fixed public IPv4 address for authenticated Bybit READ_ONLY connectivity, while keeping all order execution disabled.

**Architecture:** GitHub-hosted runners continue to execute deterministic safety tests. Authenticated Bybit account reads execute only on a dedicated self-hosted Linux x64 runner labeled `bybit-non-us`, hosted in a Bybit-supported jurisdiction with a fixed public IPv4 address. Repository secrets remain in GitHub; no Bybit credentials are stored in the repository or provisioning files.

**Tech Stack:** Linux VPS, GitHub Actions self-hosted runner, Node.js 22.13.0, Bybit V5 HMAC REST API.

**Spec:** Approved in chat on 2026-09-04: fixed-IP non-US Linux VPS -> GitHub self-hosted runner `bybit-non-us` -> GitHub Secrets -> Bybit READ_ONLY API.

## Global Constraints

- READ_ONLY only during infrastructure qualification.
- No Futures and no leverage.
- No Withdrawal permission.
- No order endpoint may be invoked.
- `BYBIT_API_KEY` and `BYBIT_API_SECRET` remain GitHub Secrets and must never be printed or committed.
- Runtime must use a fixed public IPv4 address in a Bybit-supported jurisdiction.
- The runner must carry labels `self-hosted`, `linux`, `x64`, `bybit-non-us`.
- A real-money CANARY remains blocked until a separate qualification and explicit human approval.

---

### Task 1: Provision and qualify the runtime

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: VPS provider console and fixed public IPv4.
- Produces: reachable Linux x64 host whose public egress IP is stable and non-US.

- [ ] **Step 1:** Provision a minimal Linux x64 VPS in a Bybit-supported jurisdiction with a dedicated/static IPv4 address.
- [ ] **Step 2:** Patch the host and create a non-root service account dedicated to the GitHub runner.
- [ ] **Step 3:** From the host, issue an unauthenticated HTTPS request to `https://api.bybit.com/v5/market/time` and require HTTP 200 plus Bybit `retCode: 0` before installing any account credential.
- [ ] **Step 4:** Record only the provider, region, and public IPv4 in the operator's secure inventory; do not commit credentials or tokens.

### Task 2: Register the GitHub self-hosted runner

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: GitHub one-time runner registration token and qualified VPS.
- Produces: online repository runner labeled `bybit-non-us`.

- [ ] **Step 1:** In repository Settings -> Actions -> Runners, create a new Linux x64 self-hosted runner and copy GitHub's current installation commands.
- [ ] **Step 2:** Execute GitHub's generated installation commands as the dedicated non-root service account; do not persist the one-time registration token in shell scripts or repository files.
- [ ] **Step 3:** Configure labels to include `bybit-non-us` in addition to the default `self-hosted`, `linux`, and `x64` labels.
- [ ] **Step 4:** Install the runner as a service using GitHub's generated service command and verify GitHub reports it `Idle`.

### Task 3: Execute authenticated READ_ONLY qualification

**Files:**
- Existing: `.github/workflows/algo-v2-bybit-readonly-connectivity.yml`
- Existing: `crypto-market-monitor-full-source/scripts/run-bybit-readonly-diagnostic.mjs`
- Existing: `crypto-market-monitor-full-source/algo/bybit-v5-readonly-transport.mjs`

**Interfaces:**
- Consumes: online `bybit-non-us` runner and repository secrets `BYBIT_API_KEY`, `BYBIT_API_SECRET`.
- Produces: GitHub Actions evidence for safety regression and authenticated READ_ONLY account snapshot.

- [ ] **Step 1:** Manually dispatch `ALGO V2 Bybit READ_ONLY Connectivity` from branch `agent/algo-v2-bybit-runtime-infra` after the runner is online.
- [ ] **Step 2:** Verify the hosted `safety-regression` job exits 0 before the self-hosted job starts.
- [ ] **Step 3:** Verify the authenticated job prints only redacted diagnostic status and exits 0; inspect logs for accidental credential/signature disclosure before accepting PASS.
- [ ] **Step 4:** If Bybit returns an API error, stop fail-closed and diagnose the exact `retCode`/HTTP boundary before any permission change.

### Task 4: Lock the API key to the runtime IP

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: qualified fixed public IPv4 and successful READ_ONLY evidence.
- Produces: Bybit API key restricted to the qualified runtime egress IP.

- [ ] **Step 1:** In Bybit API Management, add only the VPS fixed public IPv4 to the API key IP allowlist while retaining READ_ONLY/no-withdrawal permissions.
- [ ] **Step 2:** Re-run the authenticated READ_ONLY workflow and require the same successful account snapshot after IP restriction.
- [ ] **Step 3:** Record the successful workflow run ID and current commit SHA as qualification evidence.
- [ ] **Step 4:** Keep CANARY and all order transport disabled; opening CANARY is a separate approved change with its own tests and explicit first-order approval.
