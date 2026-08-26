import assert from "node:assert/strict";
import test from "node:test";
import { FreshnessStateSchema } from "../../src/cryptobot/domain.ts";

test("freshness states are explicit", () => {
  assert.deepEqual(FreshnessStateSchema.options, ["fresh", "aging", "stale", "unavailable"]);
});
