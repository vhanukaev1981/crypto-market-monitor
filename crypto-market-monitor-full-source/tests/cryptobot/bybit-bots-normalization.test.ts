import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBybitBotVisibility } from "../../src/cryptobot/bybit-bot-normalizer.ts";

const NOW = Date.parse("2026-08-26T12:01:00.000Z");

test("extracts bot-account equity without inventing individual bot PnL", () => {
  const result = normalizeBybitBotVisibility({
    account: {
      account_type_breakdown: [
        { type: "FUND", usd_value: 600 },
        { type: "UNIFIED", usd_value: 300 },
        { type: "TradingBot", usd_value: 200 },
      ],
    },
    checked_at: "2026-08-26T12:00:30.000Z",
    last_error: null,
  }, NOW);

  assert.equal(result.total_bot_account_equity_usd, 200);
  assert.equal(result.details_available, false);
  assert.equal(result.details_status, "account_level_only");
  assert.deepEqual(result.bots, []);
  assert.equal(result.source.freshness_state, "fresh");
});

test("missing bot account stays null instead of zero", () => {
  const result = normalizeBybitBotVisibility({
    account: { account_type_breakdown: [{ type: "FUND", usd_value: 600 }] },
    checked_at: null,
    last_error: null,
  }, NOW);
  assert.equal(result.total_bot_account_equity_usd, null);
  assert.equal(result.details_status, "bot_account_not_reported");
  assert.equal(result.source.freshness_state, "unavailable");
});

test("snapshot errors degrade bot visibility without fabricating data", () => {
  const result = normalizeBybitBotVisibility({
    account: { account_type_breakdown: [{ type: "BOT", usd_value: 200 }] },
    checked_at: "2026-08-26T11:50:00.000Z",
    last_error: "temporary upstream error",
  }, NOW);
  assert.equal(result.total_bot_account_equity_usd, 200);
  assert.equal(result.details_available, false);
  assert.equal(result.source.source_state, "attention");
  assert.equal(result.source.freshness_state, "stale");
});
