import assert from "node:assert/strict";
import test from "node:test";
import { computeFreshness, FRESHNESS_POLICIES } from "../../src/cryptobot/freshness.ts";

const NOW = Date.parse("2026-08-26T12:00:30.000Z");

test("freshness distinguishes fresh, aging, stale, and unavailable", () => {
  assert.deepEqual(
    computeFreshness("2026-08-26T12:00:25.000Z", { freshSeconds: 10, staleSeconds: 30 }, NOW),
    { ageSeconds: 5, state: "fresh" },
  );
  assert.deepEqual(
    computeFreshness("2026-08-26T12:00:15.000Z", { freshSeconds: 10, staleSeconds: 30 }, NOW),
    { ageSeconds: 15, state: "aging" },
  );
  assert.deepEqual(
    computeFreshness("2026-08-26T11:59:00.000Z", { freshSeconds: 10, staleSeconds: 30 }, NOW),
    { ageSeconds: 90, state: "stale" },
  );
  assert.deepEqual(
    computeFreshness(null, { freshSeconds: 10, staleSeconds: 30 }, NOW),
    { ageSeconds: null, state: "unavailable" },
  );
});

test("future observations clamp age to zero", () => {
  assert.deepEqual(
    computeFreshness("2026-08-26T12:00:31.000Z", { freshSeconds: 10, staleSeconds: 30 }, NOW),
    { ageSeconds: 0, state: "fresh" },
  );
});

test("production freshness policies keep Bybit cadence distinct from engine heartbeat", () => {
  assert.deepEqual(FRESHNESS_POLICIES.algobot, { freshSeconds: 15, staleSeconds: 60 });
  assert.deepEqual(FRESHNESS_POLICIES.risk, { freshSeconds: 15, staleSeconds: 60 });
  assert.deepEqual(FRESHNESS_POLICIES.reconciliation, { freshSeconds: 60, staleSeconds: 180 });
  assert.deepEqual(FRESHNESS_POLICIES.bybitAccount, { freshSeconds: 75, staleSeconds: 180 });
});
