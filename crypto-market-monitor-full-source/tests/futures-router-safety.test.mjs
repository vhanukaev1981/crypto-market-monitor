import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routerPath = new URL(
  "../supabase/functions/futures-demo-engine-router/index.ts",
  import.meta.url,
);
const enginePath = new URL(
  "../supabase/functions/futures-demo-engine/index.ts",
  import.meta.url,
);

test("נתב Futures אינו משנה את סביבת הבוט", async () => {
  const source = await readFile(routerPath, "utf8");

  assert.doesNotMatch(source, /\.update\s*\(\s*\{[^}]*environment/s);
  assert.doesNotMatch(source, /environment\s*:\s*["']demo["']/);
  assert.match(source, /\.eq\(["']environment["'],\s*["']demo_futures["']\)/);
});

test("מנוע Futures קורא ישירות את demo_futures ונשאר נעול ל־Demo", async () => {
  const source = await readFile(enginePath, "utf8");

  assert.match(source, /CONFIG_ENVIRONMENT\s*=\s*["']demo_futures["']/);
  assert.match(source, /\.eq\(["']environment["'],\s*CONFIG_ENVIRONMENT\)/);
  assert.match(source, /https:\/\/api-demo\.bybit\.com/);
  assert.doesNotMatch(source, /https:\/\/api\.bybit\.com\/v5\/order\/create/);
  assert.doesNotMatch(source, /\/v5\/asset\/withdraw\/create/);
});

test("נתב Futures נשאר נעול ל־POST ולאסימון פנימי", async () => {
  const source = await readFile(routerPath, "utf8");

  assert.match(source, /req\.method\s*!==\s*["']POST["']/);
  assert.match(source, /x-bot-cron-token/);
  assert.match(source, /schema\(["']private["']\)/);
  assert.match(source, /bot_runtime_secrets/);
});
