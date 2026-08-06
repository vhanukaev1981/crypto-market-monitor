import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routerPath = new URL(
  "../supabase/functions/futures-demo-engine-router/index.ts",
  import.meta.url,
);

test("נתב Futures אינו משנה את סביבת הבוט", async () => {
  const source = await readFile(routerPath, "utf8");

  assert.doesNotMatch(source, /\.update\s*\(\s*\{[^}]*environment/s);
  assert.doesNotMatch(source, /environment\s*:\s*["']demo["']/);
  assert.match(source, /\.eq\(["']environment["'],\s*["']demo_futures["']\)/);
  assert.match(source, /FUTURES_ENGINE_ACCEPTS_DEMO_FUTURES/);
});

test("נתב Futures נשאר נעול ל־POST ולאסימון פנימי", async () => {
  const source = await readFile(routerPath, "utf8");

  assert.match(source, /req\.method\s*!==\s*["']POST["']/);
  assert.match(source, /x-bot-cron-token/);
  assert.match(source, /schema\(["']private["']\)/);
  assert.match(source, /bot_runtime_secrets/);
});
