import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const widgetSource = join(here, "../../mcp/web/src");

function readTree(path: string): string {
  if (!existsSync(path)) return "";
  return readdirSync(path)
    .flatMap((name) => {
      const target = join(path, name);
      return statSync(target).isDirectory() ? readTree(target) : readFileSync(target, "utf8");
    })
    .join("\n");
}

test("ChatGPT widget source contains no privileged credential access", () => {
  const source = readTree(widgetSource);
  for (const forbidden of ["SUPABASE_SERVICE_ROLE_KEY", "BYBIT_LIVE_API_SECRET", "createClient("]) {
    assert.equal(source.includes(forbidden), false, `client source must not contain ${forbidden}`);
  }
});
