import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../supabase/migrations/20260806203300_observe_legacy_runtime_in_platform_mapping.sql",
  import.meta.url,
);

test("מרכז השליטה צופה ב־Legacy בלי לקבל שליטת ביצוע", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /create or replace view public\.platform_legacy_bot_mapping/i);
  assert.match(sql, /left join public\.bot_configs/i);
  assert.match(sql, /public\.platform_is_org_member/i);
  assert.match(sql, /platform_core_controls_execution/i);
  assert.match(sql, /legacy_active_observed/i);
  assert.match(sql, /live_locked/i);

  assert.doesNotMatch(sql, /update\s+public\.bot_configs/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.execution_intents/i);
  assert.doesNotMatch(sql, /net\.http_post/i);
  assert.doesNotMatch(sql, /api\.bybit\.com/i);
});

test("התצוגה נשארת זמינה לקריאה בלבד למשתמש מחובר", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /grant select on public\.platform_legacy_bot_mapping to authenticated/i);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete|all)/i);
});
