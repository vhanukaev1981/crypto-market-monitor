import assert from "node:assert/strict";
import test from "node:test";
import {
  STANDALONE_PREVIEW_TOOLS,
  isStandalonePreviewTool,
} from "../../src/cryptobot/preview-contract.ts";

const expected = [
  "open_control_center",
  "get_dashboard_overview",
  "get_algobot_status",
  "get_bybit_bots",
  "get_portfolio",
  "get_risk_status",
  "get_system_health",
  "explain_decision",
];

test("standalone preview exposes only the approved V1 read-only tools", () => {
  assert.deepEqual(STANDALONE_PREVIEW_TOOLS, expected);
});

test("standalone preview rejects mutation-like tool names", () => {
  for (const name of [
    "place_order",
    "cancel_order",
    "close_position",
    "withdraw",
    "transfer",
    "pause_strategy",
    "resume_strategy",
    "kill_switch",
  ]) {
    assert.equal(isStandalonePreviewTool(name), false, name);
  }
  for (const name of expected) assert.equal(isStandalonePreviewTool(name), true, name);
});
