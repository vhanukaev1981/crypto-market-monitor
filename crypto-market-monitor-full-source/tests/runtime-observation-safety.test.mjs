import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../supabase/migrations/20260806235000_add_platform_runtime_observation.sql",
  import.meta.url,
);
const permissionsPath = new URL(
  "../supabase/migrations/20260806235900_lock_platform_observation_views_read_only.sql",
  import.meta.url,
);
const pagePath = new URL("../app/platform/runtime/page.tsx", import.meta.url);
const layoutPath = new URL("../app/platform/layout.tsx", import.meta.url);

test("תצוגת Runtime משתמשת בהרשאות הקורא בלבד", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const permissions = await readFile(permissionsPath, "utf8");

  assert.match(sql, /create or replace view public\.platform_runtime_observation/i);
  assert.match(sql, /security_invoker\s*=\s*true/i);
  assert.doesNotMatch(sql, /update\s+public\./i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\./i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\./i);
  assert.doesNotMatch(sql, /net\.http_post/i);
  assert.doesNotMatch(sql, /api(?:-demo)?\.bybit\.com/i);

  assert.match(permissions, /revoke all on public\.platform_runtime_observation from anon, authenticated/i);
  assert.match(permissions, /grant select on public\.platform_runtime_observation to authenticated/i);
  assert.match(permissions, /revoke all on public\.platform_legacy_bot_mapping from anon, authenticated/i);
  assert.match(permissions, /grant select on public\.platform_legacy_bot_mapping to authenticated/i);
  assert.doesNotMatch(permissions, /grant\s+(insert|update|delete|all)/i);
});

test("מסך Runtime קורא את התצוגה ואינו מבצע פעולות", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /from\(["']platform_runtime_observation["']\)\.select\(["']\*["']\)/i);
  assert.doesNotMatch(source, /\.insert\s*\(/i);
  assert.doesNotMatch(source, /\.update\s*\(/i);
  assert.doesNotMatch(source, /\.delete\s*\(/i);
  assert.doesNotMatch(source, /\.upsert\s*\(/i);
  assert.doesNotMatch(source, /\.rpc\s*\(/i);
  assert.doesNotMatch(source, /functions\.invoke/i);
  assert.doesNotMatch(source, /api(?:-demo)?\.bybit\.com/i);
});

test("הניווט כולל את מסך Runtime", async () => {
  const source = await readFile(layoutPath, "utf8");
  assert.match(source, /href:\s*["']\/platform\/runtime["']/i);
  assert.match(source, /label:\s*["']Runtime חי["']/i);
});
