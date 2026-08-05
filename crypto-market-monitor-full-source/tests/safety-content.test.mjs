import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = ["app/page.tsx", "app/api/market/route.ts", "app/api/context/route.ts", "app/api/intelligence/route.ts"];
const source = files.map(file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).join("\n").toLowerCase();

test("no private-account or order execution code", () => {
  for (const pattern of ["api secret", "placeorder", "create-order", "wallet-balance", "withdraw"]) {
    assert.equal(source.includes(pattern), false, `forbidden implementation phrase: ${pattern}`);
  }
});

test("no prescriptive trade copy", () => {
  for (const pattern of ["עסקה בטוחה", "הוראת קנייה", "הוראת מכירה", "guaranteed return"]) {
    assert.equal(source.includes(pattern), false, `forbidden prescriptive phrase: ${pattern}`);
  }
});
