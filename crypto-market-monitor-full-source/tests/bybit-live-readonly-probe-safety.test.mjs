import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const functionPath = new URL(
  "../supabase/functions/bybit-live-readonly-probe/index.ts",
  import.meta.url,
);
const migrationPath = new URL(
  "../supabase/migrations/20260807002300_prepare_bybit_live_readonly_connection.sql",
  import.meta.url,
);

test("בדיקת Live משתמשת ב-Mainnet לקריאה בלבד", async () => {
  const source = await readFile(functionPath, "utf8");

  assert.match(source, /https:\/\/api\.bybit\.com/);
  assert.match(source, /\/v5\/user\/query-api/);
  assert.match(source, /\/v5\/account\/wallet-balance/);
  assert.match(source, /Number\(apiInfo\.readOnly\) !== 1/);
  assert.match(source, /trading_enabled:\s*false/);
  assert.match(source, /withdrawals_enabled:\s*false/);
  assert.match(source, /is_read_only:\s*true/);

  assert.doesNotMatch(source, /\/v5\/order\//);
  assert.doesNotMatch(source, /\/v5\/asset\/withdraw\/create/);
  assert.doesNotMatch(source, /method:\s*["']POST["']/);
  assert.doesNotMatch(source, /BYBIT_LIVE_API_SECRET\s*=\s*["'][^"']+/);
});

test("מיגרציית Live משאירה את כל שערי הביצוע נעולים", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /is_read_only\s*=\s*true/i);
  assert.match(sql, /trading_enabled\s*=\s*false/i);
  assert.match(sql, /withdrawals_enabled\s*=\s*false/i);
  assert.match(sql, /kill_switch\s*=\s*true/i);
  assert.match(sql, /live_gate_status\s*=\s*'locked'/i);
  assert.match(sql, /allow_withdrawals\s*=\s*false/i);
  assert.doesNotMatch(sql, /trading_enabled\s*=\s*true/i);
  assert.doesNotMatch(sql, /withdrawals_enabled\s*=\s*true/i);
});
